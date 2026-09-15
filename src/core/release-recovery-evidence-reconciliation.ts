// src/core/release-recovery-evidence-reconciliation.ts
// Phase 122: reconcile rollback-recovery decisions against durable evidence.
//
// Fail-closed invariant: absence, contradiction, ambiguity, identity mismatch,
// duplicate conflicting evidence, or any unresolvable condition =>
// RECOVERY_REQUIRED.
//
// This module does NOT invoke rollback providers, smoke tests, docker, or any
// verification delegate. It reads EXISTING durable evidence + intent state,
// decides, and writes exactly one reconciled event + one audit record.
import type { NexusEvent } from "./types";
import type { ReleaseDeploymentIntent } from "./execution-store";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";

export interface ReconciliationEventSink {
  emit(e: {
    type: string;
    source?: string;
    execution_id?: string | null;
    payload?: unknown;
  }): Promise<unknown> | unknown;
}
export interface ReconciliationAuditSink {
  record(e: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result?: string;
    metadata?: unknown;
  }): Promise<unknown> | unknown;
}

export type ReconciliationVerdict = "CONSISTENT" | "RECOVERY_REQUIRED";

export type ReconciliationDecision =
  | "VERIFIED"
  | "VERIFICATION_FAILED"
  | "BLOCKED"
  | "EXCEPTION"
  | "MISSING";

export interface ReconciliationResult {
  verdict: ReconciliationVerdict;
  reason: string;
  intentKey: string;
  executionId: string;
  decision: ReconciliationDecision;
  currentIntentStatus: string | null;
  workerId: string;
  timestamp: number;
}

export interface ReconciliationDeps {
  intents: ReleaseDeploymentIntentService;
  events: ReconciliationEventSink & { byExecution(id: string): Promise<NexusEvent[]> };
  audit: ReconciliationAuditSink;
  workerId: string;
}

const FORBIDDEN_KEY = /password|token|secret|auth|cookie|api[_-]?key|credential/i;

function safeReason(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function payloadOf(e: NexusEvent): Record<string, unknown> {
  const p = (e as unknown as { payload?: unknown }).payload;
  return p && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}

function containsForbiddenKey(v: unknown, depth = 0): boolean {
  if (depth > 6 || v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.some((x) => containsForbiddenKey(x, depth + 1));
  if (typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) return true;
      if (containsForbiddenKey((v as Record<string, unknown>)[k], depth + 1)) return true;
    }
  }
  return false;
}

export class ReleaseRecoveryEvidenceReconciler {
  // Phase 123: per-intent promise chain serializes concurrent reconcile() calls
  // on the same intentKey within this process so the read-check-write sequence
  // cannot interleave and produce duplicate reconciliation events. Cross-process
  // serialization is out of scope: the NEXUS kernel boots once per process and
  // its recovery executor runs once per boot.
  private static readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ReconciliationDeps) {}

  reconcile(intentKey: string): Promise<ReconciliationResult> {
    const prev = ReleaseRecoveryEvidenceReconciler.chains.get(intentKey) ?? Promise.resolve();
    const next = prev.then(
      () => this.reconcileInner(intentKey),
      () => this.reconcileInner(intentKey),
    );
    ReleaseRecoveryEvidenceReconciler.chains.set(intentKey, next.catch(() => undefined));
    return next;
  }

  private async reconcileInner(intentKey: string): Promise<ReconciliationResult> {
    const now = Date.now();
    const intent = this.deps.intents.get(intentKey);
    if (!intent) {
      return this.record(intentKey, null, "RECOVERY_REQUIRED", "MISSING", "intent not found", now);
    }

    const all = await this.deps.events.byExecution(intent.executionId);
    const relevant = all.filter((e) => payloadOf(e).intentKey === intentKey);

    // Rule J: reject evidence that carries forbidden keys.
    for (const e of relevant) {
      if (containsForbiddenKey(e.payload)) {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
          "evidence contains forbidden key", now);
      }
    }

    const started = relevant.filter((e) => (e.type as string) === "release.recovery.rollback.verification_started");
    const passed  = relevant.filter((e) => (e.type as string) === "release.recovery.rollback.verification_passed");
    const failed  = relevant.filter((e) => (e.type as string) === "release.recovery.rollback.verification_failed");
    const blocked = relevant.filter((e) => (e.type as string) === "release.recovery.rollback.verification_blocked");
    const verified = relevant.filter((e) => (e.type as string) === "release.recovery.rollback.verified");

    // Rule H: verification_started must exist exactly once.
    if (started.length === 0) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "verification_started missing", now);
    }
    if (started.length > 1) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "duplicate verification_started", now);
    }

    // Rule H/G: exactly one terminal decision event.
    const decisionCount = passed.length + failed.length + blocked.length;
    if (decisionCount === 0) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "verification decision missing", now);
    }
    if (decisionCount > 1) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "contradictory verification decisions", now);
    }

    const startedEv = started[0];
    const decisionEv = passed[0] ?? failed[0] ?? blocked[0];
    const sp = payloadOf(startedEv);
    const dp = payloadOf(decisionEv);

    // Rule F: evidence identity must match the durable intent.
    const identityChecks: Array<{ name: string; got: unknown; want: unknown }> = [
      { name: "intentKind", got: sp.intentKind, want: "ROLLBACK" },
      { name: "executionId", got: sp.executionId, want: intent.executionId },
      { name: "releaseId", got: sp.releaseId, want: intent.releaseId },
      { name: "artifactId", got: sp.artifactId, want: intent.artifactId },
      { name: "expectedArtifactDigest", got: sp.expectedArtifactDigest, want: intent.artifactDigest },
      { name: "expectedImageId", got: sp.expectedImageId, want: intent.imageId },
      {
        name: "rollbackTargetReleaseId",
        got: sp.rollbackTargetReleaseId ?? null,
        want: intent.rollbackTargetReleaseId ?? null,
      },
    ];
    for (const c of identityChecks) {
      if (c.got !== c.want) {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
          "identity mismatch: " + c.name, now);
      }
    }

    // Rule E: expected vs observed image identity.
    if (sp.observedImageId !== sp.expectedImageId) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "observed image != expected image", now);
    }
    if (typeof sp.observedContainerId !== "string" || (sp.observedContainerId as string).length === 0) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "observed container id missing", now);
    }

    // Rule G: impossible ordering.
    if (!(startedEv.timestamp <= decisionEv.timestamp)) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "impossible event ordering", now);
    }

    // Contradiction: rollback.verified requires exactly one verification_passed.
    if (verified.length > 1) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "duplicate rollback.verified", now);
    }
    if (verified.length === 1 && passed.length !== 1) {
      return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
        "rollback.verified without verification_passed", now);
    }

    const status = intent.status;

    // PASS path: Phase 121 terminal convention => intent FAILED.
    if (passed.length === 1) {
      if (status !== "FAILED") {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED", "VERIFIED",
          "verified evidence but intent status=" + status, now);
      }
      return this.record(intentKey, intent, "CONSISTENT", "VERIFIED",
        "rollback verified; evidence and terminal state agree", now);
    }

    // FAIL path: intent must be VERIFICATION_FAILED.
    if (failed.length === 1) {
      if (status !== "VERIFICATION_FAILED") {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED", "VERIFICATION_FAILED",
          "verification failed but intent status=" + status, now);
      }
      return this.record(intentKey, intent, "CONSISTENT", "VERIFICATION_FAILED",
        "verification failure reconciled with intent", now);
    }

    // BLOCKED path: intent must be RECOVERY_REQUIRED.
    if (blocked.length === 1) {
      const vs = dp.verificationStatus;
      const isException = vs === "EXCEPTION";
      if (status !== "RECOVERY_REQUIRED") {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED",
          isException ? "EXCEPTION" : "BLOCKED",
          "verification blocked but intent status=" + status, now);
      }
      // Rule I: exception never reconciles as success.
      if (isException) {
        return this.record(intentKey, intent, "RECOVERY_REQUIRED", "EXCEPTION",
          "verification exception requires manual recovery", now);
      }
      return this.record(intentKey, intent, "CONSISTENT", "BLOCKED",
        "verification block reconciled with recovery state", now);
    }

    return this.record(intentKey, intent, "RECOVERY_REQUIRED", "MISSING",
      "unreachable reconciliation state", now);
  }

  private async record(
    intentKey: string,
    intent: ReleaseDeploymentIntent | null,
    verdict: ReconciliationVerdict,
    decision: ReconciliationDecision,
    reason: string,
    now: number,
  ): Promise<ReconciliationResult> {
    const safe = safeReason(reason);
    const result: ReconciliationResult = {
      verdict,
      reason: safe,
      intentKey,
      executionId: intent?.executionId ?? "",
      decision,
      currentIntentStatus: intent?.status ?? null,
      workerId: this.deps.workerId,
      timestamp: now,
    };

    // Idempotency: skip duplicate emission if the same decision already exists.
    let alreadyRecorded = false;
    if (result.executionId) {
      try {
        const priorEvents = await this.deps.events.byExecution(result.executionId);
        for (const e of priorEvents) {
          if ((e.type as string) !== "release.recovery.rollback.evidence.reconciled") continue;
          const p = payloadOf(e);
          if (
            p.intentKey === intentKey &&
            p.verdict === verdict &&
            p.decision === decision &&
            p.reason === safe
          ) {
            alreadyRecorded = true;
            break;
          }
        }
      } catch {
        alreadyRecorded = false;
      }
    }

    if (!alreadyRecorded) {
      await this.deps.events.emit({
        type: "release.recovery.rollback.evidence.reconciled",
        source: "ReleaseRecoveryEvidenceReconciler",
        execution_id: result.executionId || null,
        payload: {
          intentKey,
          executionId: result.executionId,
          verdict,
          decision,
          reason: safe,
          recoveryWorkerId: this.deps.workerId,
          timestamp: now,
        },
      });
      await this.deps.audit.record({
        actor: this.deps.workerId,
        action: "release.recovery.rollback.evidence.reconcile",
        resource_type: "release_deployment_intent",
        resource_id: intentKey,
        result: "info",
        metadata: { verdict, decision, reason: safe },
      });
    }

    return result;
  }
}