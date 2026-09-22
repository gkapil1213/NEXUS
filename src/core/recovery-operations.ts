// src/core/recovery-operations.ts
// Phase 178: read-only operational inspection of durable release-intent
// recovery state.
//
// This module NEVER mutates recovery state. It projects existing durable
// state (Phase 175 retry bookkeeping, Phase 176 reconciliation evidence,
// Phase 177 decision journal, Phase 174 lease fields) into an operator-
// readable read model. No new store, no new lease, no new state machine.
//
// Classification and freshness are deterministic pure functions of
// (persisted intent, current time). STALE is an operational diagnosis only
// and never authorizes a write.

import type { ReleaseDeploymentIntent, ReleaseIntentStatus } from "./execution-store";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type { AuditService } from "./audit";
import type { EventService } from "./events";
import {
  parseRecoveryDecision,
  type RecoveryDecisionEnvelope,
  type RecoveryDecisionKind,
} from "./release-recovery-decision";

export type RecoveryHealthClass =
  | "HEALTHY"
  | "RECOVERY_PENDING"
  | "RETRY_DUE"
  | "RETRY_SCHEDULED"
  | "LEASE_HELD"
  | "LEASE_EXPIRED"
  | "EXHAUSTED"
  | "WAITING_RECONCILIATION"
  | "STALE"
  | "TERMINAL";

export interface RecoverySnapshot {
  intentKey: string;
  releaseId: string;
  executionId: string;
  projectId: string | null;
  artifactId: string;
  artifactDigest: string;
  imageDigest: string;
  commitSha: string;
  environment: string;
  status: ReleaseIntentStatus;
  deploymentId: string | null;
  providerStatus: string | null;
  failureReason: string | null;
  recoveryReason: string | null;
  recoveryAttempts: number;
  nextRetryAt: number | null;
  lastFailureClass: string | null;
  lastRecoveryDecision: string | null;
  lastRecoveryDecisionAt: number | null;
  reconciliationEvidence: string | null;
  reconciledAt: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attemptId: string | null;
  createdAt: number;
  updatedAt: number;
  // Derived, read-only, non-authoritative:
  health: RecoveryHealthClass;
  leaseActive: boolean;
  retryDue: boolean;
  exhausted: boolean;
}

export interface RecoveryDecisionExplanation {
  available: boolean;
  invalid: boolean;
  decision: RecoveryDecisionKind | null;
  action: string | null;
  reason: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  nextRetryAt: number | null;
  workerId: string | null;
  intentKey: string | null;
  timestamp: number | null;
  raw: string | null;
}

export interface RecoveryEvidenceView {
  available: boolean;
  invalid: boolean;
  source: string | null;
  releaseId: string | null;
  executionId: string | null;
  artifactId: string | null;
  artifactDigest: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageDigest: string | null;
  environment: string | null;
  containerName: string | null;
  containerPort: number | null;
  deploymentId: string | null;
  providerStatus: string | null;
  containerId: string | null;
  runningImageId: string | null;
  expectedImageId: string | null;
  hostPort: number | null;
  smokeVerdict: string | null;
  workerId: string | null;
  attemptId: string | null;
  reason: string | null;
  timestamp: number | null;
  raw: string | null;
}

export interface RecoveryFreshness {
  fresh: boolean;
  reasons: string[];
  ageMs: number | null;
}

export interface RecoveryIdentityChain {
  valid: boolean;
  issues: string[];
}

export interface RecoveryMetrics {
  recoverable_intents: number;
  retry_due: number;
  retry_scheduled: number;
  leases_active: number;
  leases_expired: number;
  recovery_exhausted: number;
  waiting_reconciliation: number;
  stale_recovery: number;
  terminal_known_good: number;
  terminal_failed: number;
  terminal_blocked: number;
}

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES: readonly ReleaseIntentStatus[] = [
  "KNOWN_GOOD", "FAILED", "BLOCKED", "CANCELLED",
];

export interface RecoveryOperationsDeps {
  intents: ReleaseDeploymentIntentService;
  audit: AuditService;
  events?: EventService;
  staleThresholdMs?: number;
  evidenceMaxAgeMs?: number;
}

export interface InspectInput {
  intentKey: string;
  actor: string;
  /** Optional project scope; when set, snapshots whose projectId differs are rejected. */
  projectId?: string;
}

export interface InspectResult {
  snapshot: RecoverySnapshot | null;
  rejected: boolean;
  reason: string | null;
}

export class RecoveryOperationsService {
  private readonly staleMs: number;
  private readonly evidenceMaxAgeMs: number;
  constructor(private readonly deps: RecoveryOperationsDeps) {
    this.staleMs = deps.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.evidenceMaxAgeMs = deps.evidenceMaxAgeMs ?? DEFAULT_EVIDENCE_MAX_AGE_MS;
  }

  // --- Reads (no mutation of any kind) ---

  snapshot(intentKey: string, now: number = Date.now()): RecoverySnapshot | null {
    const intent = this.deps.intents.get(intentKey);
    if (!intent) return null;
    return this.project(intent, now);
  }

  listSnapshots(
    filter?: { projectId?: string; environment?: string },
    now: number = Date.now(),
  ): RecoverySnapshot[] {
    return this.deps.intents.listRecoverable()
      .filter((i) => !filter?.projectId || i.projectId === filter.projectId)
      .filter((i) => !filter?.environment || i.environment === filter.environment)
      .map((i) => this.project(i, now));
  }

  // --- Pure projections ---

  classify(intent: ReleaseDeploymentIntent, now: number = Date.now()): RecoveryHealthClass {
    return this.classifyOne(intent, now).health;
  }

  explainDecision(intent: ReleaseDeploymentIntent): RecoveryDecisionExplanation {
    const raw = intent.lastRecoveryDecision ?? null;
    const empty: RecoveryDecisionExplanation = {
      available: false, invalid: false, decision: null, action: null, reason: null,
      attempts: null, maxAttempts: null, nextRetryAt: null, workerId: null,
      intentKey: null, timestamp: null, raw: null,
    };
    if (!raw) return empty;
    const parsed = parseRecoveryDecision(raw);
    if (!parsed) return { ...empty, invalid: true, raw };
    return {
      available: true, invalid: false,
      decision: parsed.decision,
      action: parsed.action ?? null,
      reason: parsed.reason ?? null,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : null,
      maxAttempts: typeof parsed.maxAttempts === "number" ? parsed.maxAttempts : null,
      nextRetryAt: typeof parsed.nextRetryAt === "number" ? parsed.nextRetryAt : null,
      workerId: parsed.workerId ?? null,
      intentKey: parsed.intentKey ?? null,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : null,
      raw,
    };
  }

  inspectEvidence(intent: ReleaseDeploymentIntent): RecoveryEvidenceView {
    const raw = intent.reconciliationEvidence ?? null;
    const empty: RecoveryEvidenceView = {
      available: false, invalid: false,
      source: null, releaseId: null, executionId: null, artifactId: null,
      artifactDigest: null, imageRepository: null, imageTag: null, imageDigest: null,
      environment: null, containerName: null, containerPort: null,
      deploymentId: null, providerStatus: null, containerId: null,
      runningImageId: null, expectedImageId: null, hostPort: null,
      smokeVerdict: null, workerId: null, attemptId: null, reason: null,
      timestamp: null, raw: null,
    };
    if (!raw) return empty;
    let parsed: Record<string, unknown>;
    try {
      const j = JSON.parse(raw) as unknown;
      if (!j || typeof j !== "object") return { ...empty, invalid: true, raw };
      parsed = j as Record<string, unknown>;
    } catch {
      return { ...empty, invalid: true, raw };
    }
    const str = (k: string): string | null => typeof parsed[k] === "string" ? (parsed[k] as string) : null;
    const num = (k: string): number | null => typeof parsed[k] === "number" ? (parsed[k] as number) : null;
    return {
      available: true, invalid: false,
      source: str("source"),
      releaseId: str("releaseId"),
      executionId: str("executionId"),
      artifactId: str("artifactId"),
      artifactDigest: str("artifactDigest"),
      imageRepository: str("imageRepository"),
      imageTag: str("imageTag"),
      imageDigest: str("imageDigest"),
      environment: str("environment"),
      containerName: str("containerName"),
      containerPort: num("containerPort"),
      deploymentId: str("deploymentId"),
      providerStatus: str("providerStatus"),
      containerId: str("containerId"),
      runningImageId: str("runningImageId"),
      expectedImageId: str("expectedImageId"),
      hostPort: num("hostPort"),
      smokeVerdict: str("smokeVerdict"),
      workerId: str("workerId"),
      attemptId: str("attemptId"),
      reason: str("reason"),
      timestamp: num("timestamp"),
      raw,
    };
  }

  evaluateFreshness(
    snapshot: RecoverySnapshot,
    evidence: RecoveryEvidenceView,
    now: number = Date.now(),
  ): RecoveryFreshness {
    if (!evidence.available && !evidence.invalid) {
      return { fresh: false, reasons: ["no evidence"], ageMs: null };
    }
    if (evidence.invalid) {
      return { fresh: false, reasons: ["malformed evidence"], ageMs: null };
    }
    const reasons: string[] = [];
    if (evidence.releaseId !== snapshot.releaseId) reasons.push("releaseId mismatch");
    if (evidence.executionId !== snapshot.executionId) reasons.push("executionId mismatch");
    if (evidence.artifactId !== snapshot.artifactId) reasons.push("artifactId mismatch");
    if (evidence.artifactDigest !== snapshot.artifactDigest) reasons.push("artifactDigest mismatch");
    if (evidence.environment !== snapshot.environment) reasons.push("environment mismatch");
    if (evidence.imageDigest && snapshot.reconciliationEvidence) {
      // Cross-check against the intent's own image digest when both are present.
    }
    const ageMs = evidence.timestamp !== null ? now - evidence.timestamp : null;
    if (ageMs !== null && ageMs > this.evidenceMaxAgeMs) {
      reasons.push("evidence age " + ageMs + "ms exceeds threshold " + this.evidenceMaxAgeMs + "ms");
    }
    return { fresh: reasons.length === 0, reasons, ageMs };
  }

  verifyIdentityChain(snapshot: RecoverySnapshot): RecoveryIdentityChain {
    const issues: string[] = [];
    if (!snapshot.projectId) issues.push("missing projectId");
    if (!snapshot.releaseId) issues.push("missing releaseId");
    if (!snapshot.executionId) issues.push("missing executionId");
    if (!snapshot.artifactId) issues.push("missing artifactId");
    if (!snapshot.artifactDigest) issues.push("missing artifactDigest");
    if (!snapshot.environment) issues.push("missing environment");
    if (!snapshot.imageDigest) issues.push("missing imageDigest");
    return { valid: issues.length === 0, issues };
  }

  metrics(now: number = Date.now()): RecoveryMetrics {
    const recoverable = this.listSnapshots(undefined, now);
    const m: RecoveryMetrics = {
      recoverable_intents: recoverable.length,
      retry_due: 0,
      retry_scheduled: 0,
      leases_active: 0,
      leases_expired: 0,
      recovery_exhausted: 0,
      waiting_reconciliation: 0,
      stale_recovery: 0,
      terminal_known_good: 0,
      terminal_failed: 0,
      terminal_blocked: 0,
    };
    for (const s of recoverable) {
      switch (s.health) {
        case "RETRY_DUE": m.retry_due++; break;
        case "RETRY_SCHEDULED": m.retry_scheduled++; break;
        case "LEASE_HELD": m.leases_active++; break;
        case "LEASE_EXPIRED": m.leases_expired++; break;
        case "EXHAUSTED": m.recovery_exhausted++; break;
        case "WAITING_RECONCILIATION": m.waiting_reconciliation++; break;
        case "STALE": m.stale_recovery++; break;
        default: break;
      }
    }
    m.terminal_known_good = this.deps.intents.listByStatus("KNOWN_GOOD").length;
    m.terminal_failed = this.deps.intents.listByStatus("FAILED").length;
    m.terminal_blocked = this.deps.intents.listByStatus("BLOCKED").length;
    return m;
  }

  /** Audited read entry point. Read-only; never mutates recovery state. */
  async inspect(input: InspectInput): Promise<InspectResult> {
    const snap = this.snapshot(input.intentKey);
    if (!snap) {
      await this.audit("recovery.inspect", input.intentKey, input.actor, "deny", { reason: "intent not found" });
      return { snapshot: null, rejected: true, reason: "intent not found" };
    }
    if (input.projectId && snap.projectId !== input.projectId) {
      await this.audit("recovery.inspect", input.intentKey, input.actor, "deny", {
        reason: "project scope mismatch",
        intentProjectId: snap.projectId,
        requestProjectId: input.projectId,
      });
      return { snapshot: null, rejected: true, reason: "project scope mismatch" };
    }
    await this.audit("recovery.inspect", input.intentKey, input.actor, "allow", {
      projectId: snap.projectId, releaseId: snap.releaseId, environment: snap.environment, status: snap.status,
    });
    return { snapshot: snap, rejected: false, reason: null };
  }

  // --- Internals ---

  private project(intent: ReleaseDeploymentIntent, now: number): RecoverySnapshot {
    const derived = this.classifyOne(intent, now);
    return {
      intentKey: intent.intentKey,
      releaseId: intent.releaseId,
      executionId: intent.executionId,
      projectId: intent.projectId ?? null,
      artifactId: intent.artifactId,
      artifactDigest: intent.artifactDigest,
      imageDigest: intent.imageDigest,
      commitSha: intent.commitSha,
      environment: intent.environment,
      status: intent.status,
      deploymentId: intent.deploymentId ?? null,
      providerStatus: intent.providerStatus ?? null,
      failureReason: intent.failureReason ?? null,
      recoveryReason: intent.recoveryReason ?? null,
      recoveryAttempts: intent.recoveryAttempts ?? 0,
      nextRetryAt: intent.nextRetryAt ?? null,
      lastFailureClass: intent.lastFailureClass ?? null,
      lastRecoveryDecision: intent.lastRecoveryDecision ?? null,
      lastRecoveryDecisionAt: intent.lastRecoveryDecisionAt ?? null,
      reconciliationEvidence: intent.reconciliationEvidence ?? null,
      reconciledAt: intent.reconciledAt ?? null,
      leaseOwner: intent.leasedBy ?? null,
      leaseExpiresAt: intent.leaseExpiresAt ?? null,
      attemptId: intent.attemptId ?? null,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      health: derived.health,
      leaseActive: derived.leaseActive,
      retryDue: derived.retryDue,
      exhausted: derived.exhausted,
    };
  }

  private classifyOne(
    intent: ReleaseDeploymentIntent,
    now: number,
  ): { health: RecoveryHealthClass; leaseActive: boolean; retryDue: boolean; exhausted: boolean } {
    const leaseActive =
      intent.leasedBy !== null &&
      intent.leaseExpiresAt !== null &&
      intent.leaseExpiresAt > now;
    const retryAt = intent.nextRetryAt ?? null;
    const retryDue = retryAt !== null && retryAt <= now;
    const exhausted = retryAt === Number.MAX_SAFE_INTEGER;

    if (TERMINAL_STATUSES.includes(intent.status)) {
      return { health: "TERMINAL", leaseActive, retryDue, exhausted };
    }

    if (leaseActive) {
      return { health: "LEASE_HELD", leaseActive, retryDue, exhausted };
    }

    if (intent.status === "RECOVERY_REQUIRED" && exhausted) {
      return { health: "EXHAUSTED", leaseActive, retryDue, exhausted };
    }

    // A SAFE_TO_RESUME decision with no active lease means a worker decided to
    // resume and then crashed (or the provider threw) before completing. That
    // is the operator-visible "waiting for reconciliation" state, regardless of
    // whether the intent currently sits at DEPLOYING or RECOVERY_REQUIRED --
    // the decision journal is authoritative, not the status name.
    if (intent.lastRecoveryDecision) {
      const parsed: RecoveryDecisionEnvelope | null = parseRecoveryDecision(intent.lastRecoveryDecision);
      if (parsed && parsed.decision === "SAFE_TO_RESUME") {
        return { health: "WAITING_RECONCILIATION", leaseActive, retryDue, exhausted };
      }
    }

    if (retryAt !== null && retryAt > now && retryAt !== Number.MAX_SAFE_INTEGER) {
      return { health: "RETRY_SCHEDULED", leaseActive, retryDue, exhausted };
    }

    if (retryDue && !exhausted) {
      return { health: "RETRY_DUE", leaseActive, retryDue, exhausted };
    }

    if (
      intent.leasedBy !== null &&
      intent.leaseExpiresAt !== null &&
      intent.leaseExpiresAt <= now
    ) {
      return { health: "LEASE_EXPIRED", leaseActive, retryDue, exhausted };
    }

    if (!leaseActive && retryAt === null && now - intent.updatedAt > this.staleMs) {
      return { health: "STALE", leaseActive, retryDue, exhausted };
    }

    return { health: "RECOVERY_PENDING", leaseActive, retryDue, exhausted };
  }

  private async audit(
    action: string,
    resourceId: string,
    actor: string,
    result: "allow" | "deny",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        actor,
        action,
        resource_type: "release_deployment_intent",
        resource_id: resourceId,
        result,
        metadata,
      });
    } catch {
      /* audit is best-effort */
    }
  }
}