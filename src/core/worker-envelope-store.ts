// Phase 292B: envelope persistence + keyed integrity.
//
// envelope_sha256 (migration 180) is an unkeyed prefilter: cheap, catches
// corruption, but provides ZERO defense against an attacker who can rewrite
// the SQLite file — the hash is stored next to the data it protects. The
// authoritative integrity check is envelope_hmac (migration 181), keyed by
// EnvelopeHmacKeyProvider whose key lives outside SQLite.

import { createHash } from "node:crypto";
import { NexusEngine } from "./db";
import {
  EnvelopeHmacKeyProvider,
  EnvelopeHmacKey,
  computeEnvelopeHmac,
  hmacEquals,
} from "./envelope-hmac-key-provider";

export const ENVELOPE_VERSION = 1;

export interface MessageEnvelope {
  messageId: string;
  messageType: string;
  workerId: string;
  sessionId: string;
  envelopeVersion: number;
  acceptedAt: number;
  payload: unknown;
}

export interface PersistedEnvelope extends MessageEnvelope {
  payloadSha256: string;
  /** Unkeyed prefilter (migration 180). NULL for pre-180 legacy rows. */
  envelopeSha256: string | null;
  /** Signing key id (migration 181). NULL for legacy rows. */
  kid: string | null;
  /** Authoritative keyed MAC (migration 181). NULL for legacy rows. */
  envelopeHmac: string | null;
}

export interface EnvelopePersistResult {
  persisted: boolean;
  reason?:
    | "envelope_schema_absent"
    | "payload_too_large"
    | "duplicate_message_id"
    | "invalid_payload"
    | "persistence_error";
  payloadSha256?: string;
  envelopeSha256?: string;
  envelopeHmac?: string;
  kid?: string;
}

export type EnvelopeVerifyResult =
  | { ok: true }
  | { ok: false; reason: "schema_absent" }
  | { ok: false; reason: "legacy_unverified" }
  | { ok: false; reason: "unknown_kid"; kid: string }
  | { ok: false; reason: "payload_mismatch" }
  | { ok: false; reason: "metadata_mismatch" }
  | { ok: false; reason: "hmac_mismatch" };

export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export class WorkerEnvelopeStore {
  constructor(
    private db: NexusEngine,
    private keyProvider: EnvelopeHmacKeyProvider,
  ) {}

  hasEnvelopeSchema(): boolean {
    try {
      const cols = this.db
        .prepare("PRAGMA table_info(worker_message_envelopes)")
        .all() as Array<{ name: string }>;
      if (!cols.length) return false;
      const names = new Set(cols.map((c) => c.name));
      return (
        names.has("payload_sha256") &&
        names.has("envelope_sha256") &&
        names.has("kid") &&
        names.has("envelope_hmac")
      );
    } catch {
      return false;
    }
  }

  private computeEnvelopeSha256(
    envelope: MessageEnvelope,
    payloadSha256: string,
  ): string {
    const canonical = [
      envelope.messageId,
      envelope.messageType,
      envelope.workerId,
      envelope.sessionId,
      String(envelope.envelopeVersion),
      String(envelope.acceptedAt),
      payloadSha256,
    ].join("\x00");
    return createHash("sha256").update(canonical).digest("hex");
  }

  persist(envelope: MessageEnvelope): EnvelopePersistResult {
    if (!this.hasEnvelopeSchema())
      return { persisted: false, reason: "envelope_schema_absent" };
    if (envelope.envelopeVersion !== ENVELOPE_VERSION)
      return { persisted: false, reason: "invalid_payload" };

    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(envelope.payload ?? null);
    } catch {
      return { persisted: false, reason: "invalid_payload" };
    }
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES)
      return { persisted: false, reason: "payload_too_large" };

    const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
    const envelopeSha256 = this.computeEnvelopeSha256(envelope, payloadSha256);

    // A missing or misconfigured key provider is a construction-time
    // programming error, not a data-level persistence failure. Fail loudly
    // rather than silently dropping every envelope (which is exactly the
    // failure mode migration 181 exists to prevent).
    if (!this.keyProvider) {
      throw new Error("envelope_store_missing_key_provider");
    }
    const current: EnvelopeHmacKey = this.keyProvider.currentKey();
    const envelopeHmac = computeEnvelopeHmac(current, {
      messageId: envelope.messageId,
      messageType: envelope.messageType,
      workerId: envelope.workerId,
      sessionId: envelope.sessionId,
      envelopeVersion: envelope.envelopeVersion,
      acceptedAt: envelope.acceptedAt,
      payloadSha256,
    });

    try {
      const result = this.db
        .prepare(
          `INSERT INTO worker_message_envelopes
             (message_id, message_type, worker_id, session_id, payload_json,
              payload_sha256, envelope_version, accepted_at, envelope_sha256,
              kid, envelope_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.messageId,
          envelope.messageType,
          envelope.workerId,
          envelope.sessionId,
          payloadJson,
          payloadSha256,
          envelope.envelopeVersion,
          envelope.acceptedAt,
          envelopeSha256,
          current.kid,
          envelopeHmac,
        );
      if (result.changes !== 1)
        return { persisted: false, reason: "duplicate_message_id" };
      return {
        persisted: true,
        payloadSha256,
        envelopeSha256,
        envelopeHmac,
        kid: current.kid,
      };
    } catch (e: any) {
      if (/UNIQUE constraint failed/i.test(String(e?.message ?? e)))
        return { persisted: false, reason: "duplicate_message_id" };
      // Database diagnostics may contain filesystem paths, SQL, or sensitive values.
      // Keep operational logs stable and never serialize the raw driver exception.
      // eslint-disable-next-line no-console
      console.error("worker_envelope_persist_failed", { reason: "persistence_error" });
      return { persisted: false, reason: "persistence_error" };
    }
  }

  load(messageId: string): PersistedEnvelope | undefined {
    if (!this.hasEnvelopeSchema()) return undefined;
    const row = this.db
      .prepare(
        `SELECT message_id, message_type, worker_id, session_id, payload_json,
                payload_sha256, envelope_version, accepted_at, envelope_sha256,
                kid, envelope_hmac
           FROM worker_message_envelopes WHERE message_id = ?`,
      )
      .get(messageId) as any;
    if (!row) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      return undefined;
    }
    return {
      messageId: row.message_id,
      messageType: row.message_type,
      workerId: row.worker_id,
      sessionId: row.session_id,
      payload,
      payloadSha256: row.payload_sha256,
      envelopeVersion: row.envelope_version,
      acceptedAt: row.accepted_at,
      envelopeSha256: row.envelope_sha256 ?? null,
      kid: row.kid ?? null,
      envelopeHmac: row.envelope_hmac ?? null,
    };
  }

  /** Recompute payload_sha256 from the exact stored TEXT. */
  verifyPayloadIntegrity(envelope: PersistedEnvelope): boolean {
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(envelope.payload ?? null);
    } catch {
      return false;
    }
    const expected = createHash("sha256").update(payloadJson).digest("hex");
    return hmacEquals(expected, envelope.payloadSha256);
  }

  /**
   * Backward-compatible shim used by WorkerRecoveryInspection.
   * Returns true only if the keyed MAC verifies (strict). Legacy rows
   * and unknown kids return false, exactly as the old unkeyed method did
   * for tampered/legacy rows.
   */
  verifyMetadataIntegrity(envelope: PersistedEnvelope): boolean {
    const r = this.verifyIntegrity(envelope);
    return r.ok;
  }

  /**
   * Authoritative keyed verification. Never returns ok:true for legacy rows
   * or unknown kids. Callers that need the reason should use this directly.
   */
  verifyIntegrity(envelope: PersistedEnvelope): EnvelopeVerifyResult {
    if (!this.hasEnvelopeSchema()) return { ok: false, reason: "schema_absent" };

    if (envelope.kid === null || envelope.envelopeHmac === null)
      return { ok: false, reason: "legacy_unverified" };

    if (envelope.envelopeSha256 !== null && envelope.envelopeSha256 !== undefined) {
      const expectedSha = this.computeEnvelopeSha256(
        envelope,
        envelope.payloadSha256,
      );
      if (!hmacEquals(expectedSha, envelope.envelopeSha256))
        return { ok: false, reason: "metadata_mismatch" };
    }

    if (!this.verifyPayloadIntegrity(envelope))
      return { ok: false, reason: "payload_mismatch" };

    const key = this.keyProvider.keyForKid(envelope.kid);
    if (!key) return { ok: false, reason: "unknown_kid", kid: envelope.kid };

    const expectedHmac = computeEnvelopeHmac(key, {
      messageId: envelope.messageId,
      messageType: envelope.messageType,
      workerId: envelope.workerId,
      sessionId: envelope.sessionId,
      envelopeVersion: envelope.envelopeVersion,
      acceptedAt: envelope.acceptedAt,
      payloadSha256: envelope.payloadSha256,
    });
    if (!hmacEquals(expectedHmac, envelope.envelopeHmac))
      return { ok: false, reason: "hmac_mismatch" };

    return { ok: true };
  }

  deleteEnvelope(messageId: string): boolean {
    if (!this.hasEnvelopeSchema()) return false;
    return (
      this.db
        .prepare("DELETE FROM worker_message_envelopes WHERE message_id = ?")
        .run(messageId).changes === 1
    );
  }
}


