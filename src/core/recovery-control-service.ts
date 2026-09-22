// src/core/recovery-control-service.ts
// Phase 178: operator control surface over durable release-intent recovery.
//
// Two operations only:
//   - requestReconciliation: make an intent eligible again by resetting
//     nextRetryAt to 0 under a short lease and a fenced transition.
//   - requestCancellation:  delegate to the existing idempotent
//     requestCancellation() path, gated by project scope.
//
// This service NEVER writes KNOWN_GOOD, NEVER invokes a provider or Docker,
// NEVER bypasses the recovery executor. Every write goes through an existing
// authoritative path (lease acquire/release + transitionIfOwned, or
// requestCancellation).
//
// Every control action produces a durable audit record. Rejections are
// audited as `recovery.control.rejected`; acceptances keep the specific
// action name.

import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type { AuditService } from "./audit";
import type { EventService } from "./events";

export interface ReconcileRequestInput {
  intentKey: string;
  actor: string;
  /** Optional project scope; when set, must match the intent's projectId. */
  projectId?: string;
  /**
   * When true and the intent has exhausted its retries, the control service
   * resets recoveryAttempts to 0 in addition to making the intent eligible.
   * The immutable audit ledger preserves the pre-force attempt count.
   */
  force?: boolean;
}

export interface ReconcileResult {
  accepted: boolean;
  reason: string;
  intentKey: string;
  previousNextRetryAt: number | null;
  previousAttempts: number;
  forced: boolean;
}

export interface CancelRequestInput {
  intentKey: string;
  actor: string;
  projectId?: string;
}

export interface CancelResult {
  accepted: boolean;
  reason: string;
  intentKey: string;
  idempotent: boolean;
}

const TERMINAL_STATUSES: readonly string[] = ["KNOWN_GOOD", "FAILED", "BLOCKED", "CANCELLED"];
const RECONCILE_LEASE_MS = 5_000;

export interface RecoveryControlDeps {
  intents: ReleaseDeploymentIntentService;
  audit: AuditService;
  events?: EventService;
  workerId?: string;
}

export class RecoveryControlService {
  private readonly workerId: string;
  constructor(private readonly deps: RecoveryControlDeps) {
    this.workerId = deps.workerId ?? "recovery-control";
  }

  async requestReconciliation(input: ReconcileRequestInput): Promise<ReconcileResult> {
    const reject = async (
      reason: string,
      extra: Record<string, unknown> = {},
    ): Promise<ReconcileResult> => {
      await this.auditReject("recovery.reconcile.requested", input.intentKey, input.actor, reason, extra);
      return {
        accepted: false,
        reason,
        intentKey: input.intentKey,
        previousNextRetryAt: null,
        previousAttempts: 0,
        forced: !!input.force,
      };
    };

    const fresh = this.deps.intents.get(input.intentKey);
    if (!fresh) return reject("intent not found");

    if (input.projectId && fresh.projectId !== input.projectId) {
      return reject("project scope mismatch", {
        intentProjectId: fresh.projectId ?? null,
        requestProjectId: input.projectId,
      });
    }

    if (TERMINAL_STATUSES.includes(fresh.status)) {
      return reject("terminal state", { status: fresh.status });
    }

    if (fresh.cancelRequestedAt !== null && fresh.cancelRequestedAt !== undefined) {
      return reject("cancellation already requested", {
        cancelRequestedAt: fresh.cancelRequestedAt,
      });
    }

    const previousNextRetryAt = fresh.nextRetryAt ?? null;
    const previousAttempts = fresh.recoveryAttempts ?? 0;
    const exhausted = previousNextRetryAt === Number.MAX_SAFE_INTEGER;

    if (exhausted && !input.force) {
      return reject("retries exhausted", {
        recoveryAttempts: previousAttempts,
        hint: "pass force=true to reset attempts and make eligible",
      });
    }

    const lease = this.deps.intents.acquireLease(input.intentKey, this.workerId, RECONCILE_LEASE_MS);
    if (!lease.acquired) {
      return reject("lease held by another worker", {
        holder: lease.holder,
        expiresAt: lease.expiresAt,
      });
    }

    try {
      const patch: {
        nextRetryAt: number;
        recoveryReason: string;
        recoveryAttempts?: number;
      } = {
        nextRetryAt: 0,
        recoveryReason: "operator-requested reconciliation by " + input.actor,
      };
      if (exhausted && input.force) {
        patch.recoveryAttempts = 0;
      }

      const result = this.deps.intents.transitionIfOwned(
        input.intentKey,
        fresh.status,
        this.workerId,
        patch,
        [fresh.status],
      );

      if (!result.updated) {
        return reject("fenced: transition rejected", { holder: this.workerId });
      }
    } finally {
      this.deps.intents.releaseLease(input.intentKey, this.workerId);
    }

    await this.auditAllow("recovery.reconcile.requested", input.intentKey, input.actor, {
      previousNextRetryAt,
      previousAttempts,
      forced: !!input.force,
    });
    await this.emit("recovery.reconcile.requested", input.intentKey, input.actor, {
      previousNextRetryAt,
      previousAttempts,
      forced: !!input.force,
    });

    return {
      accepted: true,
      reason: "reconciliation requested",
      intentKey: input.intentKey,
      previousNextRetryAt,
      previousAttempts,
      forced: !!input.force,
    };
  }

  async requestCancellation(input: CancelRequestInput): Promise<CancelResult> {
    const reject = async (
      reason: string,
      idempotent = false,
      extra: Record<string, unknown> = {},
    ): Promise<CancelResult> => {
      await this.auditReject("recovery.cancel.requested", input.intentKey, input.actor, reason, {
        idempotent,
        ...extra,
      });
      return { accepted: false, reason, intentKey: input.intentKey, idempotent };
    };

    const fresh = this.deps.intents.get(input.intentKey);
    if (!fresh) return reject("intent not found");

    if (input.projectId && fresh.projectId !== input.projectId) {
      return reject("project scope mismatch", false, {
        intentProjectId: fresh.projectId ?? null,
        requestProjectId: input.projectId,
      });
    }

    if (TERMINAL_STATUSES.includes(fresh.status)) {
      return reject("terminal state", false, { status: fresh.status });
    }

    if (fresh.cancelRequestedAt !== null && fresh.cancelRequestedAt !== undefined) {
      await this.auditAllow("recovery.cancel.requested", input.intentKey, input.actor, {
        idempotent: true,
      });
      return {
        accepted: true,
        reason: "cancellation already requested",
        intentKey: input.intentKey,
        idempotent: true,
      };
    }

    const changed = this.deps.intents.requestCancellation(input.intentKey);
    if (!changed) {
      return reject("cancellation not applied", false);
    }

    await this.auditAllow("recovery.cancel.requested", input.intentKey, input.actor, {
      idempotent: false,
    });
    await this.emit("recovery.cancel.requested", input.intentKey, input.actor, {
      idempotent: false,
    });

    return {
      accepted: true,
      reason: "cancellation requested",
      intentKey: input.intentKey,
      idempotent: false,
    };
  }

  // --- internals ---

  private async auditAllow(
    action: string,
    resourceId: string,
    actor: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        actor,
        action,
        resource_type: "release_deployment_intent",
        resource_id: resourceId,
        result: "allow",
        metadata,
      });
    } catch {
      /* best-effort */
    }
  }

  private async auditReject(
    attemptedAction: string,
    resourceId: string,
    actor: string,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        actor,
        action: "recovery.control.rejected",
        resource_type: "release_deployment_intent",
        resource_id: resourceId,
        result: "deny",
        metadata: { attemptedAction, reason, ...extra },
      });
    } catch {
      /* best-effort */
    }
  }

  private async emit(
    type: string,
    intentKey: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.events) return;
    try {
      await this.deps.events.emit({
        type: type as never,
        source: "RecoveryControlService",
        payload: { intentKey, actor, ...payload },
      });
    } catch {
      /* best-effort */
    }
  }
}