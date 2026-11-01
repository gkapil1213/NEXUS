// Phase 292B Slice 1: read-only recovery inspection layer.
//
// This file introduces a trust-boundary decision point for recovery: for every
// recoverable message, decide whether it is safe to replay, must be quarantined,
// or is blocked by a missing envelope. It does NOT mutate state, does NOT
// invoke handlers, and does NOT call any tracker method that writes.
//
// Phase 292B Block 0c: metadata integrity.
//   Migration 180 added envelope_sha256, a full-row hash covering identity
//   fields and payload_sha256. New rows have it populated; legacy rows
//   (pre-180) have NULL. This layer distinguishes:
//     - "integrity_fail"     : either payload hash or metadata hash fails
//                              (tampered or corrupted — hostile)
//     - "unverified_legacy"  : row was persisted before migration 180, its
//                              identity cannot be cryptographically verified
//                              (requires operator reconciliation)
//
// TRUST MODEL (documented limitation):
//   - message_type and worker_id have no authoritative counterpart in
//     worker_message_ids; they are trusted from the envelope.
//   - session_id is cross-checked against worker_message_ids.session_id.
//   - accepted_at is trusted from the envelope; migration 180's metadata
//     hash binds it, so tampering is detectable but not disprovable for
//     legacy rows.

import { NexusEngine } from "./db";
import { WorkerMessageHandlerTracker, RecoverableMessage } from "./worker-message-handler-tracker";
import { WorkerEnvelopeStore, PersistedEnvelope } from "./worker-envelope-store";
import { HandlerRegistry } from "./handler-registry";

export type QuarantineReason =
  | "integrity_fail"
  | "unverified_legacy"
  | "unknown_handler"
  | "not_replay_eligible"
  | "session_mismatch";

export type RecoveryDecision =
  | {
      kind: "REPLAY_ELIGIBLE";
      messageId: string;
      messageType: string;
      fencingToken: number;
      envelope: PersistedEnvelope;
    }
  | {
      kind: "QUARANTINE";
      messageId: string;
      messageType: string | null;
      reason: QuarantineReason;
      fencingToken: number;
    }
  | {
      kind: "BLOCKED";
      messageId: string;
      reason: "no_envelope";
      fencingToken: number;
    };

export interface InspectionResult {
  discovered: number;
  replayEligible: number;
  quarantine: number;
  blocked: number;
  byReason: Record<string, number>;
  durationMs: number;
  decisions: RecoveryDecision[];
}

export class WorkerRecoveryInspection {
  constructor(
    private db: NexusEngine,
    private tracker: WorkerMessageHandlerTracker,
    private envelopes: WorkerEnvelopeStore,
    private registry: HandlerRegistry,
  ) {
    if (this.db.kind !== "sqlite") {
      throw new Error("recovery_inspection_requires_sqlite");
    }
    if (!this.envelopes.hasEnvelopeSchema()) {
      throw new Error("recovery_inspection_requires_envelope_schema");
    }
  }

  /**
   * Inspect all currently-recoverable rows. Read-only: the only methods called
   * on collaborators are SELECTs / pure checks. No state transition occurs.
   */
  inspectOnce(): InspectionResult {
    const t0 = Date.now();
    const rows = this.tracker.listRecoverable();
    const decisions: RecoveryDecision[] = [];
    const byReason: Record<string, number> = {};
    let replayEligible = 0;
    let quarantine = 0;
    let blocked = 0;

    for (const row of rows) {
      const decision = this.decide(row);
      decisions.push(decision);
      if (decision.kind === "REPLAY_ELIGIBLE") {
        replayEligible++;
      } else if (decision.kind === "QUARANTINE") {
        quarantine++;
        byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
      } else {
        blocked++;
        byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
      }
    }

    const durationMs = Date.now() - t0;
    const result: InspectionResult = {
      discovered: rows.length,
      replayEligible,
      quarantine,
      blocked,
      byReason,
      durationMs,
      decisions,
    };

    console.log(JSON.stringify({
      event: "phase292b.inspect",
      instance: `inspect-${process.pid}`,
      discovered: result.discovered,
      replayEligible: result.replayEligible,
      quarantine: result.quarantine,
      blocked: result.blocked,
      byReason: result.byReason,
      durationMs: result.durationMs,
    }));

    return result;
  }

  private decide(row: RecoverableMessage): RecoveryDecision {
    const envelope = this.envelopes.load(row.messageId);

    if (envelope === undefined) {
      return {
        kind: "BLOCKED",
        messageId: row.messageId,
        reason: "no_envelope",
        fencingToken: row.fencingToken,
      };
    }

    // Payload integrity first: if the payload bytes don't match their stored
    // digest, the envelope is tampered. Report as integrity_fail.
    if (!this.envelopes.verifyPayloadIntegrity(envelope)) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: null,
        reason: "integrity_fail",
        fencingToken: row.fencingToken,
      };
    }

    // Legacy row: payload is intact but envelope_sha256 is NULL because the
    // row predates migration 180. We cannot verify identity fields. Report
    // as unverified_legacy (distinct from tampered).
    if (envelope.envelopeSha256 === null || envelope.envelopeSha256 === undefined) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: envelope.messageType,
        reason: "unverified_legacy",
        fencingToken: row.fencingToken,
      };
    }

    // Full metadata integrity: envelope_sha256 must match.
    if (!this.envelopes.verifyMetadataIntegrity(envelope)) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: null,
        reason: "integrity_fail",
        fencingToken: row.fencingToken,
      };
    }

    if (envelope.sessionId !== row.sessionId) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: envelope.messageType,
        reason: "session_mismatch",
        fencingToken: row.fencingToken,
      };
    }

    if (!this.registry.has(envelope.messageType)) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: envelope.messageType,
        reason: "unknown_handler",
        fencingToken: row.fencingToken,
      };
    }

    if (!this.registry.isReplayEligible(envelope.messageType)) {
      return {
        kind: "QUARANTINE",
        messageId: row.messageId,
        messageType: envelope.messageType,
        reason: "not_replay_eligible",
        fencingToken: row.fencingToken,
      };
    }

    return {
      kind: "REPLAY_ELIGIBLE",
      messageId: row.messageId,
      messageType: envelope.messageType,
      fencingToken: row.fencingToken,
      envelope,
    };
  }
}