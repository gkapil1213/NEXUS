import { ExecutionRecoveryOperationType } from "./execution-recovery-operation-store";
import { CONFIG } from "./config";
import { ExecutionStore } from "./execution-store";
import { ExecutionStateMachine } from "./execution-state-machine";
import { WorkerRegistry } from "./worker-registry";
import { LeaseManager } from "./lease-manager";
import { RetryEngine } from "./retry-engine";
import { ExecutionDispatchPort } from "./execution-dispatch-port";
import { ExecutionJob, ExecutionAttempt, ExecutionJobStatus, RetryPolicy } from "./execution-models";
import { ExecutionAdapterRequest } from "./execution-adapter";


function generateUUID(): string {
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        // Fallback to pseudo-random (not production-grade)
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export interface ExecutionEventSink {
    emit(e: {
        type: string;
        source?: string;
        execution_id?: string | null;
        payload?: Record<string, unknown>;
    }): Promise<unknown> | unknown;
}

export interface ExecutionAuditSink {
    record(e: {
        actor: string;
        action: string;
        resource_type: string;
        resource_id: string;
        result?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown> | unknown;
}

export interface ExecutionDeps {
    dispatchPort?: ExecutionDispatchPort;
    governance?: {
        evaluate(job: ExecutionJob): Promise<"ALLOW" | "APPROVAL_REQUIRED" | "DENY" | "FREEZE">;
    };
    safety?: {
        verify(job: ExecutionJob, workerId: string, leaseId: string): Promise<{ safe: boolean; reason?: string }>;
    };
    verification?: (job: ExecutionJob, result: any) => Promise<boolean>;
    // Phase 126: optional durable telemetry sinks. Absence is tolerated;
    // telemetry failure NEVER changes the actual execution outcome.
    events?: ExecutionEventSink;
    audit?: ExecutionAuditSink;
}

/**
 * Phase 126: thrown when a worker's ownership-aware mutation is rejected
 * because the lease is no longer held by that worker.  The caller must
 * treat this as ownership loss, not a transient error.
 */
export class ExecutionTransitionRejected extends Error {
    constructor(
        public readonly reason: string,
        public readonly jobId: string,
        public readonly expectedStatus: ExecutionJobStatus,
        public readonly newStatus: ExecutionJobStatus,
    ) {
        super(`Transition rejected (${reason}): ${jobId} ${expectedStatus} -> ${newStatus}`);
        this.name = "ExecutionTransitionRejected";
    }
}

// Phase 127: local structural mirrors of execution-store.ts transition types.
// TS structural typing makes these compatible with store.transitionExecution().
type TransitionActor = "worker" | "recovery" | "system";
type TransitionResult =
    | { ok: true;  applied: true;  status: ExecutionJobStatus; idempotent: false }
    | { ok: true;  applied: false; status: ExecutionJobStatus; idempotent: true  }
    | { ok: false;
        reason: "WORKER_OWNERSHIP_LOST" | "STATE_MISMATCH" | "TERMINAL_STATE" | "JOB_NOT_FOUND";
        currentStatus: ExecutionJobStatus | null };
type TransitionInput = {
    jobId: string;
    actor: TransitionActor;
    expectedStatus: ExecutionJobStatus;
    newStatus: ExecutionJobStatus;
    workerId?: string;
    leaseId?: string;
    reason?: string;
    now?: number;
    patch?: Partial<Pick<ExecutionJob,
        | "currentLeaseId" | "retryPolicy" | "timeoutMs"
        | "lastAttemptAt" | "nextAttemptAt"
        | "cancellationRequested" | "cancellationAcknowledged">>;
};

export class OwnershipLostError extends Error {
    constructor(
        public readonly jobId: string,
        public readonly leaseId: string,
        public readonly workerId: string,
    ) {
        super(`WORKER_OWNERSHIP_LOST: job=${jobId} lease=${leaseId} worker=${workerId}`);
        this.name = "OwnershipLostError";
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

export class ExecutionEngine {
    private stateMachine = new ExecutionStateMachine();

    /**
     * Phase 154: process-local shutdown flag. When true, recoverStaleJobs()
     * and reconcileExecutionRecoveryOperations() return immediately.
     *
     * This is convenience, not correctness: durable claims are not released
     * here. A worker that exits while holding a claim leaves that claim
     * durable so that the existing lease-expiry path can hand it to another
     * engine after expiry.
     */
    private shuttingDown = false;

    // ============================================================
  // Phase 183d: async attempt-persistence facade.
  // When the store has an async backend (shared mode), route the four
  // attempt mutations through Postgres. Otherwise use the sync path.
  // ============================================================

  hasAsyncPersistence(): boolean {
    return this.store.hasAsyncBackend();
  }

  private async createAttemptAsOwnerAtomicIO(
    ...args: Parameters<ExecutionStore["createAttemptAsOwnerAtomic"]>
  ): Promise<Awaited<ReturnType<ExecutionStore["createAttemptAsOwnerAtomic"]>>> {
    if (this.store.hasAsyncBackend()) {
      return this.store.createAttemptAsOwnerAtomicAsync(...args);
    }
    return this.store.createAttemptAsOwnerAtomic(...args);
  }

  private async updateAttemptAsOwnerIO(
    ...args: Parameters<ExecutionStore["updateAttemptAsOwner"]>
  ): Promise<Awaited<ReturnType<ExecutionStore["updateAttemptAsOwner"]>>> {
    if (this.store.hasAsyncBackend()) {
      return this.store.updateAttemptAsOwnerAsync(...args);
    }
    return this.store.updateAttemptAsOwner(...args);
  }

  private async completeAttemptAndTransitionJobIO(
    input: Parameters<ExecutionStore["completeAttemptAndTransitionJob"]>[0],
  ): Promise<Awaited<ReturnType<ExecutionStore["completeAttemptAndTransitionJob"]>>> {
    if (this.store.hasAsyncBackend()) {
      return this.store.completeAttemptAndTransitionJobAsync(input);
    }
    return this.store.completeAttemptAndTransitionJob(input);
  }

  shutdown(): void {
        this.shuttingDown = true;
    }

    isShuttingDown(): boolean {
        return this.shuttingDown;
    }

    private readonly recoveryInstanceId = generateUUID();
    /** @internal Phase 144 - test-only injection hook. No-op in production. */
    public __testPhase144Hook?: (stage: string) => void;

    private recoveryOwnerId(): string {
        const pid = (typeof process !== "undefined" && process.pid) ? String(process.pid) : "0";
        return "engine-" + pid + "-" + this.recoveryInstanceId;
    }

    /**
     * Phase 144: run one durable recovery operation end to end.
     *
     * Creates the operation if needed, claims it with this engine instance as
     * owner, executes the supplied body, and advances the operation to a
     * terminal state according to the body result. If the claim cannot be
     * obtained (another live owner holds it) this is a no-op; reconciliation
     * will pick it up later.
     */
    private runRecoveryOperation(input: {
        jobId: string;
        leaseId: string | null;
        workerId: string | null;
        operationType: ExecutionRecoveryOperationType;
        now: number;
        body: () => { ok: boolean; error?: string; recoveryRequired?: string };
    }): void {
        const ops = this.store.recoveryOps;

        const created = ops.createOrGetOperation({
            jobId: input.jobId,
            leaseId: input.leaseId,
            workerId: input.workerId,
            operationType: input.operationType,
            now: input.now,
        });

        const op = created.operation;
        if (op.state === "COMPLETED") return;

        this.__testPhase144Hook?.("afterCreate");

        const owner = this.recoveryOwnerId();

        const claim = ops.claimOperation({
            operationId: op.operationId,
            owner,
            durationMs: 60000,
            now: input.now,
        });

        if (!claim.claimed) return;

        this.__testPhase144Hook?.("afterClaim");

        const started = ops.markInProgress(
            op.operationId,
            owner,
            input.now
        );

        if (!started) return;

        this.__testPhase144Hook?.("afterInProgress");

        try {
            const result = input.body();

            if (result.ok) {
                this.__testPhase144Hook?.("beforeComplete");

                const completed = ops.markCompleted(
                    op.operationId,
                    owner,
                    input.now
                );

                if (!completed) return;

                return;
            }

            if (result.recoveryRequired) {
                const marked = ops.markRecoveryRequired(
                    op.operationId,
                    owner,
                    result.recoveryRequired,
                    input.now
                );

                if (!marked) return;

                return;
            }

            const failed = ops.markFailed(
                op.operationId,
                owner,
                result.error ?? "RECOVERY_FAILED",
                input.now
            );

            if (!failed) return;
        } catch (err: any) {
            const failed = ops.markFailed(
                op.operationId,
                owner,
                String(err?.message ?? err),
                input.now
            );

            if (!failed) return;
        }
    }


    constructor(
        private store: ExecutionStore,
        private workerRegistry: WorkerRegistry,
        private leaseManager: LeaseManager,
        private retryEngine: RetryEngine,
        private deps: ExecutionDeps = {}
    ) {}

    /** Fire-and-forget a possibly-async telemetry call; swallow any failure. */
    private fireAndForget(p: unknown): void {
        if (p && typeof (p as { then?: unknown }).then === "function") {
            (p as Promise<unknown>).catch(() => { /* telemetry failure isolated */ });
        }
    }

    /**
     * Phase 126: ownership-aware state mutation.
     *
     * Every post-claim status change goes through here.  If the supplied
     * lease is no longer ACTIVE/owned by this worker, the database update
     * affects zero rows Ã¢â‚¬â€ we do NOT overwrite the new owner's state.
     *
     * On ownership loss we:
     *   1. write a durable ownership-loss obligation (idempotent per job+lease)
     *   2. emit `execution.ownership_lost` (best-effort)
     *   3. write an audit record (best-effort)
     *   4. throw OwnershipLostError Ã¢â‚¬â€ deterministic, not silent
     */
    private static readonly ACTOR_ALLOWED: Record<
        TransitionActor,
        Array<[ExecutionJobStatus, ExecutionJobStatus]>
    > = {
        worker: [
            ["CLAIMED", "RUNNING"],
            ["RUNNING", "SUCCEEDED"],
            ["RUNNING", "VERIFYING"],
            ["VERIFYING", "SUCCEEDED"],
            ["VERIFYING", "FAILED"],
            ["RUNNING", "FAILED"],
            ["RUNNING", "CANCELLED"],
            ["VERIFYING", "CANCELLED"],
            ["RUNNING", "BLOCKED"],
            ["CANCELLATION_REQUESTED", "RUNNING"],
            ["CANCELLATION_REQUESTED", "CANCELLED"],
        ],
        recovery: [
            ["CLAIMED", "ORPHANED"],
            ["RUNNING", "ORPHANED"],
            ["VERIFYING", "ORPHANED"],
            ["ORPHANED", "QUEUED"],
            ["ORPHANED", "FAILED"],
            ["ORPHANED", "DEAD_LETTER"],
        ],
        system: [
            ["QUEUED", "CLAIMED"],
            ["QUEUED", "BLOCKED"],
            ["QUEUED", "CANCELLED"],
            ["QUEUED", "CANCELLATION_REQUESTED"],
            ["RUNNING", "CANCELLATION_REQUESTED"],
            ["VERIFYING", "CANCELLATION_REQUESTED"],
            ["FAILED", "RETRY_SCHEDULED"],
            ["FAILED", "DEAD_LETTER"],
            ["RETRY_SCHEDULED", "QUEUED"],
            ["RETRY_SCHEDULED", "CANCELLED"],
            ["CANCELLATION_REQUESTED", "CANCELLED"],
        ],
    };

    /**
     * Phase 127: single entry point for every durable execution transition.
     * Enforces, in order: state-machine legality, actor-role policy, and
     * expected-state CAS + ownership fencing at the store.  On
     * WORKER_OWNERSHIP_LOST writes a durable obligation.
     */
    private applyTransition(
        jobId: string,
        actor: TransitionActor,
        expectedStatus: ExecutionJobStatus,
        newStatus: ExecutionJobStatus,
        workerId?: string,
        leaseId?: string,
        patch?: TransitionInput["patch"],
        reason?: string,
    ): TransitionResult {
        if (!this.stateMachine.canTransition(expectedStatus, newStatus)) {
            this.emitTransitionAudit(jobId, actor, expectedStatus, newStatus, "illegal_transition", workerId, leaseId, reason);
            throw new ExecutionTransitionRejected("ILLEGAL_TRANSITION", jobId, expectedStatus, newStatus);
        }
        const allowed = ExecutionEngine.ACTOR_ALLOWED[actor] ?? [];
        if (!allowed.some(([f, t]) => f === expectedStatus && t === newStatus)) {
            this.emitTransitionAudit(jobId, actor, expectedStatus, newStatus, "actor_not_allowed", workerId, leaseId, reason);
            throw new ExecutionTransitionRejected("ACTOR_NOT_ALLOWED", jobId, expectedStatus, newStatus);
        }

        const result = this.store.transitionExecution({
            jobId, actor, expectedStatus, newStatus, workerId, leaseId, patch, reason,
        });

        if (result.ok) {
            this.emitTransitionAudit(jobId, actor, expectedStatus, newStatus,
                result.idempotent ? "idempotent" : "applied", workerId, leaseId, reason);
                this.fireAndForget(this.deps.events?.emit({
                    type: `execution.transition.${newStatus.toLowerCase()}`,
                    source: "ExecutionEngine",
                    execution_id: jobId,
                    payload: {
                        from: expectedStatus,
                        to: newStatus,
                        actor,
                        workerId: workerId ?? null,
                        leaseId: leaseId ?? null,
                        reason: reason ?? null,
                    },
                }));
            return result;
        }

        if (result.reason === "WORKER_OWNERSHIP_LOST") {
            try {
                this.store.writeOwnershipObligation({
                    jobId,
                    leaseId: leaseId ?? "unknown",
                    workerId: workerId ?? "unknown",
                    reason: reason ?? "TRANSITION_REJECTED",
                });
            } catch { /* obligation failure does not mask the loss */ }
        }
        this.emitTransitionAudit(jobId, actor, expectedStatus, newStatus,
            result.reason.toLowerCase(), workerId, leaseId, reason);
        throw new ExecutionTransitionRejected(result.reason, jobId, expectedStatus, newStatus);
    }

    private emitTransitionAudit(
        jobId: string,
        actor: TransitionActor,
        from: ExecutionJobStatus,
        to: ExecutionJobStatus,
        result: string,
        workerId?: string,
        leaseId?: string,
        reason?: string,
    ): void {
        try {
            this.fireAndForget(this.deps.audit?.record({
                actor: workerId ?? actor,
                action: "execution.transition",
                resource_type: "execution_job",
                resource_id: jobId,
                result,
                metadata: { from, to, actor, leaseId: leaseId ?? null, reason: reason ?? null },
            }));
        } catch { /* isolated */ }
    }

    createJob(
        jobType: string,
        payload: any,
        idempotencyKey: string,
        retryPolicy?: RetryPolicy,
        timeoutMs?: number
    ): ExecutionJob {
        const existing = this.store.getJobByIdempotencyKey(idempotencyKey);
        if (existing) return existing;

        const now = Date.now();
        const job: ExecutionJob = {
            id: generateUUID(),
            idempotencyKey,
            jobType,
            payload,
            status: "QUEUED",
            retryPolicy,
            timeoutMs,
            createdAt: now,
            updatedAt: now,
            cancellationRequested: false,
            cancellationAcknowledged: false,
        };
        this.store.createJob(job);
        return job;
    }

    claimNextJob(workerId: string): { job: ExecutionJob; lease: any } | null {
        const queued = this.store.listJobsByStatus("QUEUED");
        for (const job of queued) {
            if (job.cancellationRequested) continue;

            // Phase 142: single-transaction atomic claim. The lease INSERT and
            // the QUEUED -> CLAIMED transition with current_lease_id binding
            // commit together, or neither commits.
            const r = this.store.atomicClaimJob({
                jobId: job.id,
                workerId,
                durationMs: 60000,
            });
            if (!r.claimed || !r.lease) continue;

            // Durable CLAIMED state and durable execution.transition.claimed
            // event were committed by atomicClaimJob(). No second transition,
            // no second event, no compensating audit.
            const fresh = this.store.getJob(job.id);
            if (!fresh) continue;
            // Phase 184: sync claimNextJob preserved for SQLite mode and legacy
            // callers. Shared-mode distributed claim uses claimNextJobAsync
            // (Postgres FOR UPDATE SKIP LOCKED) via the worker runtime.
            this.workerRegistry.markBusy(workerId, job.id);
            return { job: fresh, lease: r.lease };
        }
        return null;
    }

    /**
     * Phase 184: shared-mode claim. Same semantics as sync claimNextJob but
     * routes through atomicClaimJobAsync so concurrent callers in independent
     * processes are serialized by PostgreSQL (SELECT ... FOR UPDATE SKIP LOCKED).
     * Only valid when store.hasAsyncBackend() is true.
     */
    async claimNextJobAsync(workerId: string): Promise<{ job: ExecutionJob; lease: any } | null> {
        const queued = await this.store.listJobsByStatusAsync("QUEUED");
        for (const job of queued) {
            if (job.cancellationRequested) continue;

            const r = await this.store.atomicClaimJobAsync({
                jobId: job.id,
                workerId,
                durationMs: 60000,
            });
            if (!r.claimed || !r.lease) continue;

            const fresh = await this.store.getJobAsync(job.id);
            if (!fresh) continue;
            await this.markBusyIO(workerId, job.id);
            return { job: fresh, lease: r.lease };
        }
        return null;
    }


    /**
     * Phase 136: called when a worker-authoritative attempt write is fenced out.
     * Records a durable ownership obligation and emits audit/events Ã¢â‚¬â€ WITHOUT
     * mutating authoritative execution state.
     */
    private recordAttemptOwnershipLoss(jobId: string, leaseId: string, workerId: string, reason: string): void {
        try { this.store.writeOwnershipObligation({ jobId, leaseId, workerId, reason }); } catch { /* isolated */ }
        try {
            this.fireAndForget(this.deps.events?.emit({
                type: "execution.ownership_lost",
                source: "ExecutionEngine",
                execution_id: jobId,
                payload: { jobId, leaseId, workerId, reason, phase: "attempt_write" },
            }));
        } catch { /* isolated */ }
        try {
            this.fireAndForget(this.deps.audit?.record({
                actor: workerId, action: "execution.ownership_lost",
                resource_type: "execution_job", resource_id: jobId,
                result: "blocked",
                metadata: { leaseId, reason, phase: "attempt_write" },
            }));
        } catch { /* isolated */ }
    }
  
  // ---------- Phase 183 final: shared-mode IO helpers ----------
  // Mirror the createAttemptAsOwnerAtomicIO pattern: pick async backend
  // when present, sync SQLite otherwise. Never mix.

  private async releaseLeaseIO(leaseId: string): Promise<void> {
    if (this.store.hasAsyncBackend()) {
      await this.leaseManager.releaseLeaseAsync(leaseId);
    } else {
      this.leaseManager.releaseLease(leaseId);
    }
  }

  private async markIdleIO(workerId: string): Promise<void> {
    if (this.store.hasAsyncBackend()) {
      await this.workerRegistry.markIdleAsync(workerId);
    } else {
      this.workerRegistry.markIdle(workerId);
    }
  }

  private async markBusyIO(workerId: string, jobId: string): Promise<void> {
    if (this.store.hasAsyncBackend()) {
      await this.workerRegistry.markBusyAsync(workerId, jobId);
    } else {
      this.workerRegistry.markBusy(workerId, jobId);
    }
  }

  private async validateLeaseIO(leaseId: string, workerId: string): Promise<boolean> {
    if (this.store.hasAsyncBackend()) {
      return this.leaseManager.validateLeaseAsync(leaseId, workerId);
    }
    return this.leaseManager.validateLease(leaseId, workerId);
  }

  private async recoverExpiredLeasesIO(now: number) {
    if (this.store.hasAsyncBackend()) {
      return this.leaseManager.recoverExpiredLeasesAsync(now);
    }
    return this.leaseManager.recoverExpiredLeases(now);
  }

  private async detectLostWorkersIO(now: number, maxAgeMs: number) {
    if (this.store.hasAsyncBackend()) {
      return this.workerRegistry.detectLostWorkersAsync(now, maxAgeMs);
    }
    return this.workerRegistry.detectLostWorkers(now, maxAgeMs);
  }
    // Phase 184: async sibling of runRecoveryOperation. Used in shared mode
    // when the recovery bookkeeping and the body mutations must both persist
    // to Postgres. Same flow, awaits async ops and an async body().
    private async runRecoveryOperationAsync(input: {
        jobId: string;
        leaseId: string | null;
        workerId: string | null;
        operationType: ExecutionRecoveryOperationType;
        now: number;
        body: () => Promise<{ ok: boolean; error?: string; recoveryRequired?: string }>;
    }): Promise<void> {
        // Phase 184: dual-mode. SQLite mode uses the sync recovery-op store;
        // shared mode uses the async one. The body is always async-shaped --
        // in SQLite mode the awaits resolve synchronously.
        if (!this.store.hasAsyncBackend()) {
            const syncOps = this.store.recoveryOps;
            const created = syncOps.createOrGetOperation({
                jobId: input.jobId,
                leaseId: input.leaseId,
                workerId: input.workerId,
                operationType: input.operationType,
                now: input.now,
            });
            const op = created.operation;
            if (op.state === "COMPLETED") return;
            this.__testPhase144Hook?.("afterCreate");
            const owner = this.recoveryOwnerId();
            const claim = syncOps.claimOperation({
                operationId: op.operationId,
                owner,
                durationMs: 60000,
                now: input.now,
            });
            if (!claim.claimed) return;
            this.__testPhase144Hook?.("afterClaim");
            const started = syncOps.markInProgress(op.operationId, owner, input.now);
            if (!started) return;
            this.__testPhase144Hook?.("afterInProgress");
            try {
                const result = await input.body();
                if (result.ok) {
                    this.__testPhase144Hook?.("beforeComplete");
                    syncOps.markCompleted(op.operationId, owner, input.now);
                    return;
                }
                if (result.recoveryRequired) {
                    syncOps.markRecoveryRequired(op.operationId, owner, result.recoveryRequired, input.now);
                    return;
                }
                syncOps.markFailed(op.operationId, owner, result.error ?? "RECOVERY_FAILED", input.now);
            } catch (err: any) {
                syncOps.markFailed(op.operationId, owner, String(err?.message ?? err), input.now);
            }
            return;
        }

        const ops = this.store.recoveryOpsAsync;
        if (!ops) throw new Error("runRecoveryOperationAsync requires shared mode");

        const created = await ops.createOrGetOperation({
            jobId: input.jobId,
            leaseId: input.leaseId,
            workerId: input.workerId,
            operationType: input.operationType,
            now: input.now,
        });

        const op = created.operation;
        if (op.state === "COMPLETED") return;

        this.__testPhase144Hook?.("afterCreate");
        const owner = this.recoveryOwnerId();

        const claim = await ops.claimOperation({
            operationId: op.operationId,
            owner,
            durationMs: 60000,
            now: input.now,
        });
        if (!claim.claimed) return;
        this.__testPhase144Hook?.("afterClaim");

        const started = await ops.markInProgress(op.operationId, owner, input.now);
        if (!started) return;
        this.__testPhase144Hook?.("afterInProgress");

        try {
            const result = await input.body();
            if (result.ok) {
                this.__testPhase144Hook?.("beforeComplete");
                await ops.markCompleted(op.operationId, owner, input.now);
                return;
            }
            if (result.recoveryRequired) {
                await ops.markRecoveryRequired(op.operationId, owner, result.recoveryRequired, input.now);
                return;
            }
            await ops.markFailed(op.operationId, owner, result.error ?? "RECOVERY_FAILED", input.now);
        } catch (err: any) {
            await ops.markFailed(op.operationId, owner, String(err?.message ?? err), input.now);
        }
    }

    // ---------- Phase 184: async-aware IO adapters (shared vs local) ----------

    private async recoverJobAtomicIO(input: {
        jobId: string;
        expectedStatus: string;
        newStatus: string;
        expectedLeaseId: string | null;
        patch?: { nextAttemptAt?: number | null };
        event: { eventType: string; payload: Record<string, unknown> };
        obligation?: { leaseId: string; workerId: string; reason: string };
    }): Promise<{ ok: boolean; obligationId?: string; obligationCreated?: boolean }> {
        if (this.store.hasAsyncBackend()) {
            return this.store.recoverJobAtomicAsync(input as any);
        }
        return this.store.recoverJobAtomic(input as any);
    }

    private async writeOwnershipObligationIO(input: {
        jobId: string;
        leaseId: string;
        workerId: string;
        reason: string;
        now?: number;
    }): Promise<{ obligationId: string; created: boolean }> {
        if (this.store.hasAsyncBackend()) {
            return this.store.writeOwnershipObligationAsync(input);
        }
        return this.store.writeOwnershipObligation(input);
    }

    private async getJobIO(jobId: string): Promise<ExecutionJob | undefined> {
        if (this.store.hasAsyncBackend()) {
            return this.store.getJobAsync(jobId);
        }
        return this.store.getJob(jobId);
    }

    private async listAttemptsForJobIO(jobId: string): Promise<ExecutionAttempt[]> {
        if (this.store.hasAsyncBackend()) {
            return this.store.listAttemptsForJobAsync(jobId);
        }
        return this.store.listAttemptsForJob(jobId);
    }

    private async listJobsByStatusIO(status: string): Promise<ExecutionJob[]> {
        if (this.store.hasAsyncBackend()) {
            return this.store.listJobsByStatusAsync(status);
        }
        return this.store.listJobsByStatus(status);
    }
  // ============================================================
  // Phase 196: execution supervision.
  // ============================================================

  async recordHeartbeat(
    jobId: string, attemptId: string, workerId: string, leaseId: string,
    now: number = Date.now(),
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.store.hasAsyncBackend()) return { ok: false, reason: "SHARED_MODE_NOT_IMPLEMENTED" };
    const res = this.store.recordAttemptHeartbeatAsOwner(attemptId, jobId, leaseId, workerId, now);
    if (res.updated) {
      try {
        this.fireAndForget(this.deps.events?.emit({
          type: "execution.supervision.heartbeat",
          source: "ExecutionEngine",
          execution_id: jobId,
          payload: { jobId, attemptId, workerId, leaseId, at: now },
        }));
      } catch { /* isolated */ }
      return { ok: true };
    }
    return { ok: false, reason: res.reason ?? "HEARTBEAT_REJECTED" };
  }

  async recordProgress(
    jobId: string, attemptId: string, workerId: string, leaseId: string,
    now: number = Date.now(),
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.store.hasAsyncBackend()) return { ok: false, reason: "SHARED_MODE_NOT_IMPLEMENTED" };
    const res = this.store.recordAttemptProgressAsOwner(attemptId, jobId, leaseId, workerId, now);
    if (res.updated) {
      try {
        this.fireAndForget(this.deps.events?.emit({
          type: "execution.supervision.progress",
          source: "ExecutionEngine",
          execution_id: jobId,
          payload: { jobId, attemptId, workerId, leaseId, at: now },
        }));
      } catch { /* isolated */ }
      return { ok: true };
    }
    return { ok: false, reason: res.reason ?? "PROGRESS_REJECTED" };
  }

  classifySupervision(
    jobId: string,
    now: number = Date.now(),
    heartbeatTimeoutMs: number = 30_000,
    progressTimeoutMs: number = 300_000,
  ): {
    verdict: "HEALTHY" | "HEARTBEAT_TIMEOUT" | "PROGRESS_TIMEOUT" | "NOT_RUNNING" | "NO_ATTEMPT";
    jobStatus: string | null; attemptId: string | null;
    lastHeartbeatAt: number | null; lastProgressAt: number | null;
    heartbeatDeadline: number | null; progressDeadline: number | null;
    reason: string;
  } {
    const empty = { jobStatus: null, attemptId: null, lastHeartbeatAt: null, lastProgressAt: null, heartbeatDeadline: null, progressDeadline: null };
    const job = this.store.getJob(jobId);
    if (!job) return { ...empty, verdict: "NOT_RUNNING", reason: "JOB_NOT_FOUND" };
    if (job.status !== "RUNNING" && job.status !== "VERIFYING" && job.status !== "CLAIMED") {
      return { ...empty, verdict: "NOT_RUNNING", jobStatus: job.status, reason: "STATUS_" + job.status };
    }
    const attempts = this.store.listAttemptsForJob(jobId);
    const running = attempts.filter((a) => a.status === "RUNNING");
    if (running.length === 0) return { ...empty, verdict: "NO_ATTEMPT", jobStatus: job.status, reason: "NO_RUNNING_ATTEMPT" };
    const attempt = running[running.length - 1];
    const prog = this.store.getAttemptProgress(attempt.id);
    const hb = prog.heartbeatAt;
    const pr = prog.lastProgressAt;
    const hbDeadline = hb === null ? null : hb + heartbeatTimeoutMs;
    const prDeadline = pr === null ? null : pr + progressTimeoutMs;
    const base = { jobStatus: job.status, attemptId: attempt.id, lastHeartbeatAt: hb, lastProgressAt: pr, heartbeatDeadline: hbDeadline, progressDeadline: prDeadline };
    if (hb === null) return { ...base, verdict: "HEARTBEAT_TIMEOUT", reason: "NO_HEARTBEAT_RECORDED" };
    if (hbDeadline !== null && hbDeadline < now) return { ...base, verdict: "HEARTBEAT_TIMEOUT", reason: "HEARTBEAT_DEADLINE_EXCEEDED" };
    if (prDeadline !== null && prDeadline < now) return { ...base, verdict: "PROGRESS_TIMEOUT", reason: "PROGRESS_DEADLINE_EXCEEDED" };
    return { ...base, verdict: "HEALTHY", reason: "OK" };
  }

  // ============================================================
  // Phase 196: supervisor tick — supervision pass.
  // Read-only with respect to ExecutionJobStatus. Writes only the
  // supervision_state / failure_class columns added by migration 166
  // and emits a stall_detected event when a running attempt has aged
  // past the configured stale-attempt window while its lease is still
  // ACTIVE (the exact case Phase 194's expired-lease path cannot see).
  // ============================================================

  runSupervisionPass(
    now: number = Date.now(),
    staleAttemptMs: number = CONFIG.recovery.staleAttemptMs,
    heartbeatTimeoutMs: number = CONFIG.recovery.heartbeatTimeoutMs,
    progressTimeoutMs: number = CONFIG.recovery.progressTimeoutMs,
  ): { scanned: number; flagged: number } {
    const stale = this.store.listStaleAttempts(now, staleAttemptMs);
    let flagged = 0;
    for (const att of stale) {
      const verdict = this.classifySupervision(att.jobId, now, heartbeatTimeoutMs, progressTimeoutMs);
      if (verdict.verdict !== "HEARTBEAT_TIMEOUT" && verdict.verdict !== "PROGRESS_TIMEOUT") continue;
      try { this.store.setJobSupervision(att.jobId, "SUSPECTED_STALL", verdict.verdict, now); }
      catch { /* store failures must not break the tick */ }
      flagged++;
      try {
        this.fireAndForget(this.deps.events?.emit({
          type: "execution.supervision.stall_detected",
          source: "ExecutionEngine",
          execution_id: att.jobId,
          payload: {
            jobId: att.jobId, attemptId: att.attemptId,
            leaseId: att.leaseId, workerId: att.workerId,
            verdict: verdict.verdict, reason: verdict.reason,
            lastHeartbeatAt: verdict.lastHeartbeatAt,
            lastProgressAt: verdict.lastProgressAt,
          },
        }));
      } catch { /* isolated */ }
    }
    return { scanned: stale.length, flagged };
  }

  // ============================================================
  // Phase 197: sync supervisor recovery driver (SQLite).
  // Mirrors DistributedScheduler.recoverStaleAttemptsTick for the
  // default runtime. For each heartbeat-stale OR progress-stale
  // RUNNING attempt: fenceStaleAttempt (attempt FAILED, lease EXPIRED,
  // job ORPHANED), then requeue via recoverJobAtomic iff the retry
  // policy allows. When it does not, the job remains ORPHANED with
  // failure_class set and recovery.blocked is emitted.
  //
  // Idempotent: fenceStaleAttempt's CAS makes a second tick a no-op.
  // Concurrency-safe: the CAS on status='RUNNING' + lease_id + cutoff
  // means only one supervisor ever wins per attempt.
  // ============================================================

  recoverStalledAttemptsTick(
    now: number = Date.now(),
    staleAttemptMs: number = CONFIG.recovery.staleAttemptMs,
    heartbeatTimeoutMs: number = CONFIG.recovery.heartbeatTimeoutMs,
    progressTimeoutMs: number = CONFIG.recovery.progressTimeoutMs,
  ): { scanned: number; fenced: number; requeued: number; blocked: number } {
    // Heartbeat-stale first, then progress-stale with fresh heartbeat.
    const hbStale = this.store.listStaleAttempts(now, staleAttemptMs);
    const prStale = this.store.listProgressStaleAttempts(now, progressTimeoutMs, heartbeatTimeoutMs);

    // Dedupe by attemptId in case an attempt somehow appears in both
    // (defensive: with heartbeatFreshMs < heartbeatTimeoutMs this
    // cannot happen, but guard anyway).
    const seen = new Set<string>();
    const queue: Array<{ attemptId: string; jobId: string; leaseId: string; kind: string }> = [];
    for (const a of hbStale) {
      if (seen.has(a.attemptId)) continue;
      seen.add(a.attemptId);
      queue.push({ attemptId: a.attemptId, jobId: a.jobId, leaseId: a.leaseId, kind: 'HEARTBEAT_TIMEOUT' });
    }
    for (const a of prStale) {
      if (seen.has(a.attemptId)) continue;
      seen.add(a.attemptId);
      queue.push({ attemptId: a.attemptId, jobId: a.jobId, leaseId: a.leaseId, kind: 'PROGRESS_TIMEOUT' });
    }

    let fenced = 0, requeued = 0, blocked = 0;
    for (const q of queue) {
      const fr = this.store.fenceStaleAttempt({
        attemptId: q.attemptId,
        jobId: q.jobId,
        leaseId: q.leaseId,
        reason: q.kind,
        now,
        mode: q.kind === 'PROGRESS_TIMEOUT' ? 'progress' : 'heartbeat',
        staleCutoffMs: q.kind === 'PROGRESS_TIMEOUT' ? progressTimeoutMs : staleAttemptMs,
        heartbeatFreshMs: heartbeatTimeoutMs,
      });
      if (!fr.fenced) continue;
      fenced++;

      try { this.store.setJobSupervision(q.jobId, 'RECOVERY_PENDING', q.kind, now); } catch { /* isolated */ }

      const job = this.store.getJob(q.jobId);
      if (!job || job.status !== 'ORPHANED') continue;

      let canRetry = false;
      if (job.retryPolicy) {
        const attempts = this.store.listAttemptsForJob(job.id);
        canRetry = attempts.length < job.retryPolicy.maxAttempts;
      }

      if (!canRetry) {
        blocked++;
        try { this.store.setJobSupervision(q.jobId, 'RECOVERY_BLOCKED', 'RETRY_EXHAUSTED', now); } catch { /* isolated */ }
        try {
          this.fireAndForget(this.deps.events?.emit({
            type: 'execution.recovery.blocked',
            source: 'ExecutionEngine',
            execution_id: q.jobId,
            payload: { jobId: q.jobId, attemptId: q.attemptId, leaseId: q.leaseId, reason: 'RETRY_EXHAUSTED', stall: q.kind },
          }));
        } catch { /* isolated */ }
        continue;
      }

      const rr = this.store.recoverJobAtomic({
        jobId: job.id,
        expectedStatus: 'ORPHANED',
        newStatus: 'QUEUED',
        expectedLeaseId: null,
        patch: { nextAttemptAt: now } as any,
        event: {
          eventType: 'execution.recovery.stale_attempt_requeued',
          payload: { jobId: job.id, attemptId: q.attemptId, leaseId: q.leaseId, reason: q.kind },
        },
      });
      if (rr.ok) {
        requeued++;
        try { this.store.setJobSupervision(q.jobId, 'RECOVERED', q.kind, now); } catch { /* isolated */ }
      } else {
        blocked++;
      }
    }

    return { scanned: queue.length, fenced, requeued, blocked };
  }


  async executeJob(workerId: string, jobId: string, leaseId: string): Promise<ExecutionJob> {
        const job = this.store.getJob(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);

        if (!(await this.validateLeaseIO(leaseId, workerId))) {
            // Phase 126: ownership already lost.  Do NOT clobber the job row Ã¢â‚¬â€
            // another worker may now own it.  Record the durable obligation,
            // emit telemetry, and throw a typed error so callers can react.
            let obligationId = "unknown";
            try {
                const ob = this.store.writeOwnershipObligation({
                    jobId: job.id,
                    leaseId,
                    workerId,
                    reason: "LEASE_LOST_AT_EXECUTE",
                });
                obligationId = ob.obligationId;
            } catch { /* isolated */ }
            try {
                this.fireAndForget(this.deps.events?.emit({
                    type: "execution.ownership_lost",
                    source: "ExecutionEngine",
                    execution_id: job.id,
                    payload: { jobId: job.id, leaseId, workerId, obligationId, phase: "execute_precheck" },
                }));
            } catch { /* isolated */ }
            try {
                this.fireAndForget(this.deps.audit?.record({
                    actor: workerId,
                    action: "execution.ownership_lost",
                    resource_type: "execution_job",
                    resource_id: job.id,
                    result: "blocked",
                    metadata: { leaseId, obligationId, phase: "execute_precheck" },
                }));
            } catch { /* isolated */ }
            throw new OwnershipLostError(job.id, leaseId, workerId);
        }

        this.applyTransition(job.id, "worker", "CLAIMED", "RUNNING", workerId, leaseId, undefined, "WORKER_STARTED");
        job.status = "RUNNING";
        job.updatedAt = Date.now();

        const attCreateRes = await this.createAttemptAsOwnerAtomicIO(jobId, leaseId, workerId, "RUNNING");
        if (!attCreateRes.created) {
            this.recordAttemptOwnershipLoss(job.id, leaseId, workerId, "ATTEMPT_CREATE_" + attCreateRes.reason);
            throw new OwnershipLostError(job.id, leaseId, workerId);
        }
        const attempt: ExecutionAttempt = attCreateRes.attempt;
        const attemptNumber = attempt.attemptNumber;

        const request: ExecutionAdapterRequest = {
            operation: job.jobType,
            args: job.payload?.args || [],
            cwd: job.payload?.cwd,
            env: job.payload?.env,
            timeoutMs: job.timeoutMs,
            metadata: { jobId: job.id, idempotencyKey: job.idempotencyKey },
        };

        if (this.deps.governance) {
            const decision = await this.deps.governance.evaluate(job);
            if (decision === "DENY" || decision === "FREEZE") {
                this.applyTransition(
                    job.id, "worker", "RUNNING", "BLOCKED",
                    workerId, leaseId, undefined,
                    decision === "FREEZE" ? "GOVERNANCE_FREEZE" : "GOVERNANCE_DENIED"
                );
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                await this.releaseLeaseIO(leaseId);
                job.currentLeaseId = undefined;
                await this.markIdleIO(workerId);
                return job;
            }
            if (decision === "APPROVAL_REQUIRED") {
                // Phase 127 STEP 7: execution has no APPROVAL_REQUIRED state.
                // Map to BLOCKED with a distinct durable audit reason.
                this.applyTransition(
                    job.id, "worker", "RUNNING", "BLOCKED",
                    workerId, leaseId, undefined, "GOVERNANCE_APPROVAL_REQUIRED"
                );
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                try {
                    this.fireAndForget(this.deps.audit?.record({
                        actor: workerId,
                        action: "execution.approval_required",
                        resource_type: "execution_job",
                        resource_id: job.id,
                        result: "blocked",
                        metadata: { leaseId },
                    }));
                } catch { /* isolated */ }
                await this.releaseLeaseIO(leaseId);
                job.currentLeaseId = undefined;
                await this.markIdleIO(workerId);
                return job;
            }
        }

        if (this.deps.safety) {
            const safetyResult = await this.deps.safety.verify(job, workerId, leaseId);
            if (!safetyResult.safe) {
                this.applyTransition(
                    job.id, "worker", "RUNNING", "BLOCKED",
                    workerId, leaseId, undefined, "SAFETY_VERIFY_FAILED"
                );
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                await this.releaseLeaseIO(leaseId);
                job.currentLeaseId = undefined;
                await this.markIdleIO(workerId);
                return job;
            }
        }

        let executionResult: any = null;
        let executionError: string | undefined;
        let timedOut = false;

        try {
            if (this.deps.dispatchPort) {
                // We need the lease object; fetch from store or use leaseId? LeaseManager has getLease?


                const { dispatchId } = await this.deps.dispatchPort.dispatch(job, attempt, leaseId, request);
                executionResult = await this.deps.dispatchPort.collectResult(dispatchId);
            } else {
                throw new Error("No dispatch port provided");
            }
        } catch (err: any) {
            executionError = err?.message || String(err);
            if (executionError && executionError.includes("timed out")) timedOut = true;
        }

        attempt.completedAt = Date.now();

        const freshCancel = this.store.getJob(job.id);
        if (freshCancel?.cancellationRequested) {
            job.cancellationRequested = true;
            {
                const __cancelled = this.store.recoverJobToStatus(
                    job.id,
                    freshCancel.status,
                    "CANCELLED",
                    leaseId,
                    { now: Date.now() }
                );
                if (__cancelled) {
                    const __refreshed = this.store.getJob(job.id);
                    if (__refreshed) {
                        __refreshed.cancellationAcknowledged = true;
                        this.store.updateJob(__refreshed);
                    }
                } else {
                    throw new OwnershipLostError(job.id, leaseId, workerId);
                }
            }
            attempt.status = "CANCELLED";
            attempt.evidence = ["Execution cancelled after completion"];
            attempt.completedAt = Date.now();
            const attResCancelPost = await this.updateAttemptAsOwnerIO(attempt, leaseId, workerId);
            if (!attResCancelPost.updated) {
                this.recordAttemptOwnershipLoss(job.id, leaseId, workerId, "ATTEMPT_WRITE_CANCELLED");
            }
            job.status = "CANCELLED";
            job.cancellationAcknowledged = true;
            job.updatedAt = Date.now();
            await this.releaseLeaseIO(leaseId);
            await this.markIdleIO(workerId);
            return job;
        }

        if (!executionResult || !executionResult.success) {
            // Phase 136: compute retry outcome BEFORE any attempt write.
            let nextStatus: ExecutionJobStatus;
            let nextAttemptAt: number | undefined;
            if (timedOut && job.retryPolicy) {
                const na = this.retryEngine.calculateNextAttempt(attemptNumber, job.retryPolicy, Date.now());
                if (na !== null) { nextStatus = "RETRY_SCHEDULED"; nextAttemptAt = na; }
                else { nextStatus = "DEAD_LETTER"; }
            } else if (job.retryPolicy && this.retryEngine.isRetryable(executionError || "Execution failed", job.retryPolicy)) {
                const na = this.retryEngine.calculateNextAttempt(attemptNumber, job.retryPolicy, Date.now());
                if (na !== null) { nextStatus = "RETRY_SCHEDULED"; nextAttemptAt = na; }
                else { nextStatus = "DEAD_LETTER"; }
            } else {
                nextStatus = "DEAD_LETTER";
            }

            const freshCancel = this.store.getJob(job.id);
        if (freshCancel?.cancellationRequested) {
            job.cancellationRequested = true;
                {
                    const __cancelled = this.store.recoverJobToStatus(
                        job.id,
                        freshCancel.status,
                        "CANCELLED",
                        leaseId,
                        { now: Date.now() }
                    );
                    if (__cancelled) {
                        const __refreshed = this.store.getJob(job.id);
                        if (__refreshed) {
                            __refreshed.cancellationAcknowledged = true;
                            this.store.updateJob(__refreshed);
                        }
                    } else {
                        throw new OwnershipLostError(job.id, leaseId, workerId);
                    }
                }
                attempt.status = "CANCELLED";
                attempt.error = executionError || "Execution failed";
                attempt.completedAt = Date.now();
                const attResFailCancel = await this.updateAttemptAsOwnerIO(attempt, leaseId, workerId);
                if (!attResFailCancel.updated) {
                    this.recordAttemptOwnershipLoss(job.id, leaseId, workerId, "ATTEMPT_WRITE_FAILED_CANCELLED");
                }
                job.status = "CANCELLED";
                job.cancellationAcknowledged = true;
                job.updatedAt = Date.now();
                await this.releaseLeaseIO(leaseId);
                job.currentLeaseId = undefined;
                await this.markIdleIO(workerId);
                return job;
            }

            await this.applyTransitionWithAttempt({
                jobId: job.id,
                expectedJobStatus: "RUNNING",
                newJobStatus: "FAILED",
                attemptId: attempt.id,
                attemptStatus: "FAILED",
                attemptError: executionError || "Execution failed",
                attemptEvidence: attempt.evidence,
                attemptCompletedAt: Date.now(),
                workerId, leaseId,
                reason: "EXECUTION_FAILED",
            });
            job.status = "FAILED";
            job.updatedAt = Date.now();

            this.applyTransition(
                job.id, "system", "FAILED", nextStatus,
                undefined, undefined,
                nextAttemptAt !== undefined ? { nextAttemptAt } : undefined,
                nextStatus === "RETRY_SCHEDULED" ? "RETRY_SCHEDULED" : "DEAD_LETTER"
            );
            job.status = nextStatus;
            if (nextAttemptAt !== undefined) job.nextAttemptAt = nextAttemptAt;
            job.updatedAt = Date.now();
            await this.releaseLeaseIO(leaseId);
            job.currentLeaseId = undefined;
            await this.markIdleIO(workerId);
            return job;
        }

        // ==============================================================
        // Phase 128: canonical completion lifecycle.
        //
        //   verification configured:  RUNNING -> VERIFYING -> SUCCEEDED
        //                                                    \-> FAILED -> RETRY/DEAD
        //   no verification:          RUNNING -> SUCCEEDED
        //
        // Every durable transition goes through this.applyTransition(...).
        // No state cast. No invalid VERIFYING -> SUCCEEDED from RUNNING.
        // Success attempt is persisted only AFTER the authoritative
        // RUNNING/VERIFYING -> SUCCEEDED transition has been applied,
        // so ownership loss cannot persist a false SUCCEEDED attempt.
        // ==============================================================

        if (this.deps.verification) {
            this.applyTransition(
                job.id, "worker", "RUNNING", "VERIFYING",
                workerId, leaseId, undefined, "VERIFICATION_STARTED"
            );
            job.status = "VERIFYING";
            job.updatedAt = Date.now();

            let verificationSuccess = true;
            try {
                verificationSuccess = await this.deps.verification(job, executionResult);
            } catch (err: any) {
                verificationSuccess = false;
                attempt.error = `Verification failed: ${err.message}`;
            }

            if (verificationSuccess) {
                // Durable transition FIRST Ã¢â‚¬â€ ownership loss must not
                // persist a false SUCCEEDED attempt.
                await this.applyTransitionWithAttempt({
                    jobId: job.id,
                    expectedJobStatus: "VERIFYING",
                    newJobStatus: "SUCCEEDED",
                    attemptId: attempt.id,
                    attemptStatus: "SUCCEEDED",
                    attemptEvidence: ["Verification succeeded"],
                    attemptCompletedAt: Date.now(),
                    workerId, leaseId,
                    reason: "VERIFICATION_SUCCEEDED",
                });

                job.status = "SUCCEEDED";
                job.updatedAt = Date.now();
                await this.releaseLeaseIO(leaseId);
                job.currentLeaseId = undefined;
                await this.markIdleIO(workerId);
                return job;
            }

            // Phase 136: compute outcome FIRST, transition FIRST, fenced attempt write.
            const verifErrMsg = attempt.error ?? "Verification failed";
            let nextStatus: ExecutionJobStatus;
            let nextAttemptAt: number | undefined;
            if (job.retryPolicy && this.retryEngine.isRetryable(verifErrMsg, job.retryPolicy)) {
                const na = this.retryEngine.calculateNextAttempt(attemptNumber, job.retryPolicy, Date.now());
                if (na !== null) { nextStatus = "RETRY_SCHEDULED"; nextAttemptAt = na; }
                else { nextStatus = "DEAD_LETTER"; }
            } else {
                nextStatus = "DEAD_LETTER";
            }

            await this.applyTransitionWithAttempt({
                jobId: job.id,
                expectedJobStatus: "VERIFYING",
                newJobStatus: "FAILED",
                attemptId: attempt.id,
                attemptStatus: "FAILED",
                attemptError: verifErrMsg,
                attemptEvidence: attempt.evidence,
                attemptCompletedAt: Date.now(),
                workerId, leaseId,
                reason: "VERIFICATION_FAILED",
            });
            job.status = "FAILED";
            job.updatedAt = Date.now();
            this.applyTransition(
                job.id, "system", "FAILED", nextStatus,
                undefined, undefined,
                nextAttemptAt !== undefined ? { nextAttemptAt } : undefined,
                nextStatus === "RETRY_SCHEDULED" ? "RETRY_SCHEDULED" : "DEAD_LETTER"
            );
            job.status = nextStatus;
            if (nextAttemptAt !== undefined) job.nextAttemptAt = nextAttemptAt;
            job.updatedAt = Date.now();
            await this.releaseLeaseIO(leaseId);
            job.currentLeaseId = undefined;
            await this.markIdleIO(workerId);
            return job;
        }

        // No verification configured: direct RUNNING -> SUCCEEDED.
        // Do NOT fabricate a VERIFYING transition.
        await this.applyTransitionWithAttempt({
            jobId: job.id,
            expectedJobStatus: "RUNNING",
            newJobStatus: "SUCCEEDED",
            attemptId: attempt.id,
            attemptStatus: "SUCCEEDED",
            attemptEvidence: ["Execution succeeded (verification not configured)"],
            attemptCompletedAt: Date.now(),
            workerId, leaseId,
            reason: "EXECUTION_COMPLETE_NO_VERIFICATION",
        });

        job.status = "SUCCEEDED";
        job.updatedAt = Date.now();
        await this.releaseLeaseIO(leaseId);
        job.currentLeaseId = undefined;
        await this.markIdleIO(workerId);

        return job;
    }

    /**
     * Phase 146: recovery-path retry decision.
     *
     * The live executeJob path bounds retries via RetryEngine.calculateNextAttempt,
     * which returns null once the attempt budget is exhausted. The recovery paths
     * historically substituted a weaker proxy (!!retryPolicy && canTransition),
     * so a job that had already consumed its retry budget could be resurrected by
     * lease-loss recovery and run attempts beyond maxAttempts.
     *
     * This helper restores parity: attempts used is read from the durable
     * execution_attempts table, and the same budget check the live path uses is
     * applied before allowing RETRY_SCHEDULED or QUEUED from recovery.
     */
    private recoveryCanRetry(job: ExecutionJob, from: ExecutionJobStatus, to: ExecutionJobStatus, attemptsUsedOverride?: number): boolean {
        if (!job.retryPolicy) return false;
        const attemptsUsed = attemptsUsedOverride ?? this.store.listAttemptsForJob(job.id).length;
        if (attemptsUsed >= job.retryPolicy.maxAttempts) return false;
        return this.stateMachine.canTransition(from, to);
    }

    /**
     * Phase 147: promote same-tick recovery retries.
     *
     * A recovery operation can set a job to RETRY_SCHEDULED with nextAttemptAt
     * equal to the current tick's now. Because runDueRetries uses now - 1 to
     * preserve the pre-existing due-time boundary for older retries, such a
     * same-tick retry would otherwise wait until the next recovery cycle.
     * This helper closes that gap for jobs that were NOT already
     * RETRY_SCHEDULED at the start of recoverStaleJobs.
     *
     * Pre-existing RETRY_SCHEDULED jobs are excluded so their promotion stays
     * governed exclusively by runDueRetries.
     */
    private promoteImmediateRecoveryRetries(
        now: number,
        preExistingRetryScheduledJobIds: Set<string>,
    ): void {
        for (const job of this.store.listJobsByStatus("RETRY_SCHEDULED")) {
            if (preExistingRetryScheduledJobIds.has(job.id)) continue;
            if (job.nextAttemptAt !== now) continue;

            if (job.cancellationRequested) {
                this.store.recoverJobAtomic({
                    jobId: job.id,
                    expectedStatus: "RETRY_SCHEDULED",
                    newStatus: "CANCELLED",
                    expectedLeaseId: null,
                    event: { eventType: "execution.retry.cancelled", payload: { jobId: job.id, reason: "cancellation_requested_during_immediate_retry" } },
                });
                continue;
            }

            this.store.recoverJobAtomic({
                jobId: job.id,
                expectedStatus: "RETRY_SCHEDULED",
                newStatus: "QUEUED",
                expectedLeaseId: null,
                event: { eventType: "execution.retry.due", payload: { jobId: job.id, previousNextAttemptAt: job.nextAttemptAt } },
            });
        }
    }

    /**
     * Phase 147: promote due retries to QUEUED.
     *
     * Jobs routed to RETRY_SCHEDULED by the live path or by any recovery path
     * carry a durable next_attempt_at and wait to be picked up. Nothing else
     * consumes them today. This method:
     *
     *   1. Escalates invariant violations: RETRY_SCHEDULED jobs with no valid
     *      next_attempt_at cannot match listJobsDueForRetry (NULL <= now is
     *      false in SQLite). They are transitioned to ORPHANED with a
     *      diagnostic event so the recovery pass re-evaluates eligibility
     *      through the Phase 146 budget check.
     *
     *   2. Promotes due RETRY_SCHEDULED jobs to QUEUED via recoverJobAtomic,
     *      CAS-fenced on expectedStatus="RETRY_SCHEDULED". Concurrent engines
     *      converge: the loser sees zero rows affected and writes no event.
     *      Cancellation is honoured by routing to CANCELLED instead.
     *
     * The promotion clears next_attempt_at because recoverJobAtomic sets
     * next_attempt_at = patch?.nextAttemptAt ?? null and the patch is omitted.
     */
    private runDueRetries(now: number): void {
        for (const job of this.store.listJobsByStatus("RETRY_SCHEDULED")) {
            if (typeof job.nextAttemptAt === "number" && job.nextAttemptAt > 0) continue;
            this.store.recoverJobAtomic({
                jobId: job.id,
                expectedStatus: "RETRY_SCHEDULED",
                newStatus: "ORPHANED",
                expectedLeaseId: null,
                event: {
                    eventType: "execution.retry.invariant_violation",
                    payload: {
                        jobId: job.id,
                        reason: "RETRY_SCHEDULE_MISSING_NEXT_ATTEMPT_AT",
                        observedNextAttemptAt: job.nextAttemptAt ?? null,
                    },
                },
            });
        }

        for (const job of this.store.listJobsDueForRetry(now)) {
            const fresh = this.store.getJob(job.id);
            if (!fresh || fresh.status !== "RETRY_SCHEDULED") continue;

            if (fresh.cancellationRequested) {
                this.store.recoverJobAtomic({
                    jobId: fresh.id,
                    expectedStatus: "RETRY_SCHEDULED",
                    newStatus: "CANCELLED",
                    expectedLeaseId: null,
                    event: { eventType: "execution.retry.cancelled", payload: { jobId: fresh.id, reason: "cancellation_requested_before_retry_due" } },
                });
                continue;
            }

            this.store.recoverJobAtomic({
                jobId: fresh.id,
                expectedStatus: "RETRY_SCHEDULED",
                newStatus: "QUEUED",
                expectedLeaseId: null,
                event: { eventType: "execution.retry.due", payload: { jobId: fresh.id, previousNextAttemptAt: fresh.nextAttemptAt ?? null } },
            });
        }
    }

    /**
     * Phase 126: stale-execution recovery.
     *
     * A recovered expired lease is NOT automatically safe to retry.  For
     * each affected execution we:
     *   1. emit `execution.lease.expired`
     *   2. transition to ORPHANED (the only valid state from RUNNING/CLAIMED/VERIFYING)
     *   3. write a durable ownership-loss obligation (idempotent per job+lease)
     *   4. classify as RECOVERABLE (retryPolicy AND ORPHANED->QUEUED valid)
     *      or RECOVERY_REQUIRED (anything else)
     *   5. re-queue only the RECOVERABLE class
     *   6. emit `execution.recovery_completed` or `execution.recovery_required`
     *   7. write an audit record for the recovery action
     *
     * Terminal states are never touched.  The obligation write is idempotent,
     * so repeated detection converges on one row.
     */
    /**
     * Phase 150: atomic parent transition + attempt terminalization.
     *
     * Same legality + actor checks as applyTransition(), then delegates to
     * store.completeAttemptAndTransitionJob so the parent UPDATE, the attempt
     * UPDATE, and the durable transition event commit or roll back together.
     */
    private async applyTransitionWithAttempt(input: {
        jobId: string;
        expectedJobStatus: ExecutionJobStatus;
        newJobStatus: ExecutionJobStatus;
        attemptId: string;
        attemptStatus: "SUCCEEDED" | "FAILED" | "CANCELLED";
        attemptError?: string;
        attemptEvidence?: string[];
        attemptCompletedAt?: number;
        workerId?: string;
        leaseId?: string;
        patch?: TransitionInput["patch"];
        reason?: string;
    }): Promise<TransitionResult> {
        if (!this.stateMachine.canTransition(input.expectedJobStatus, input.newJobStatus)) {
            this.emitTransitionAudit(input.jobId, "worker", input.expectedJobStatus, input.newJobStatus,
                "illegal_transition", input.workerId, input.leaseId, input.reason);
            throw new ExecutionTransitionRejected("ILLEGAL_TRANSITION",
                input.jobId, input.expectedJobStatus, input.newJobStatus);
        }
        const allowed = ExecutionEngine.ACTOR_ALLOWED["worker"] ?? [];
        if (!allowed.some(([f, t]) => f === input.expectedJobStatus && t === input.newJobStatus)) {
            this.emitTransitionAudit(input.jobId, "worker", input.expectedJobStatus, input.newJobStatus,
                "actor_not_allowed", input.workerId, input.leaseId, input.reason);
            throw new ExecutionTransitionRejected("ACTOR_NOT_ALLOWED",
                input.jobId, input.expectedJobStatus, input.newJobStatus);
        }
        if (!input.workerId || !input.leaseId) {
            throw new ExecutionTransitionRejected("WORKER_OWNERSHIP_LOST",
                input.jobId, input.expectedJobStatus, input.newJobStatus);
        }

        const result = await this.completeAttemptAndTransitionJobIO({
            attemptId: input.attemptId,
            jobId: input.jobId,
            leaseId: input.leaseId,
            workerId: input.workerId,
            attemptStatus: input.attemptStatus,
            attemptError: input.attemptError,
            attemptEvidence: input.attemptEvidence,
            attemptCompletedAt: input.attemptCompletedAt,
            expectedJobStatus: input.expectedJobStatus,
            newJobStatus: input.newJobStatus,
            patch: input.patch,
            reason: input.reason,
        });

        if (result.ok) {
            this.emitTransitionAudit(input.jobId, "worker", input.expectedJobStatus, input.newJobStatus,
                result.idempotent ? "idempotent" : "applied", input.workerId, input.leaseId, input.reason);
            this.fireAndForget(this.deps.events?.emit({
                type: "execution.transition." + input.newJobStatus.toLowerCase(),
                source: "ExecutionEngine",
                execution_id: input.jobId,
                payload: {
                    from: input.expectedJobStatus,
                    to: input.newJobStatus,
                    actor: "worker",
                    workerId: input.workerId,
                    leaseId: input.leaseId,
                    reason: input.reason ?? null,
                },
            }));
            if (result.idempotent) {
                return { ok: true, applied: false, status: input.newJobStatus, idempotent: true };
            }
            return { ok: true, applied: true, status: input.newJobStatus, idempotent: false };
        }

        if (result.reason === "WORKER_OWNERSHIP_LOST") {
            try {
                this.store.writeOwnershipObligation({
                    jobId: input.jobId,
                    leaseId: input.leaseId,
                    workerId: input.workerId,
                    reason: input.reason ?? "TRANSITION_REJECTED",
                });
            } catch { /* obligation failure does not mask the loss */ }
        }
        this.emitTransitionAudit(input.jobId, "worker", input.expectedJobStatus, input.newJobStatus,
            (result.reason ?? "STATE_MISMATCH").toLowerCase(), input.workerId, input.leaseId, input.reason);
        throw new ExecutionTransitionRejected(
            (result.reason ?? "STATE_MISMATCH") as any,
            input.jobId, input.expectedJobStatus, input.newJobStatus);
    }

    async recoverStaleJobs(now: number = Date.now()): Promise<void> {
        if (this.shuttingDown) return;
        // Phase 147: capture pre-existing RETRY_SCHEDULED job IDs before
        // any recovery runs, so same-tick recovery retries can be promoted
        // later without disturbing the existing due-time boundary used for
        // pre-existing retries.
        const preExistingRetryScheduledJobIds = new Set<string>(
            (await this.listJobsByStatusIO("RETRY_SCHEDULED")).map((j) => j.id),
        );
        this.reconcileExecutionRecoveryOperations(now);
        // Phase 196: supervision pass first. Does not touch ExecutionJobStatus;
        // writes only supervision_state / failure_class and emits stall_detected.
        try { this.runSupervisionPass(now); } catch { /* isolated */ }

        const expiredLeases = await this.recoverExpiredLeasesIO(now);
        for (const lease of expiredLeases) {
            try {
                this.fireAndForget(this.deps.events?.emit({
                    type: "execution.lease.expired",
                    source: "ExecutionEngine",
                    execution_id: lease.jobId,
                    payload: {
                        jobId: lease.jobId,
                        leaseId: lease.leaseId,
                        workerId: lease.workerId,
                        expiredAt: lease.expiresAt,
                    },
                }));
            } catch { /* isolated */ }

            const job = await this.getJobIO(lease.jobId);
            if (!job) continue;

            if (
                job.status === "SUCCEEDED" ||
                job.status === "FAILED" ||
                job.status === "CANCELLED" ||
                job.status === "DEAD_LETTER"
            ) {
                continue;
            }

            if (
                job.status !== "RUNNING" &&
                job.status !== "CLAIMED" &&
                job.status !== "VERIFYING" &&
                job.status !== "CANCELLATION_REQUESTED"
            ) {
                continue;
            }

            const freshCancel = await this.getJobIO(job.id);
            if (freshCancel?.cancellationRequested) {
                await this.runRecoveryOperationAsync({
                    jobId: job.id,
                    leaseId: lease.leaseId,
                    workerId: lease.workerId,
                    operationType: "CANCELLATION",
                    now,
                    body: async () => {
                        const live = await this.getJobIO(job.id);
                        if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                        const result = await this.recoverJobAtomicIO({
                            jobId: job.id,
                            expectedStatus: live.status,
                            newStatus: "CANCELLED",
                            expectedLeaseId: live.currentLeaseId ?? null,
                            event: { eventType: "execution.recovery.cancelled", payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, from: live.status, to: "CANCELLED", reason: "cancellation_requested_honoured_after_lease_loss" } },
                            obligation: { leaseId: lease.leaseId, workerId: lease.workerId, reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
                        });
                        if (result.ok) return { ok: true };
                        const after = await this.getJobIO(job.id);
                        if (after?.status === "CANCELLED") return { ok: true };
                        return { ok: false, error: "CANCELLATION_FAILED" };
                    },
                });

                const after = await this.getJobIO(job.id);
                if (after?.status === "CANCELLED") {
                    try {
                        this.fireAndForget(this.deps.events?.emit({
                            type: "execution.recovery_completed",
                            source: "ExecutionEngine",
                            execution_id: job.id,
                            payload: {
                                jobId: job.id,
                                leaseId: lease.leaseId,
                                workerId: lease.workerId,
                                classification: "CANCELLED",
                                newStatus: "CANCELLED",
                                reason: "cancellation_requested_honoured_after_lease_loss",
                            },
                        }));
                    } catch { /* isolated */ }
                }
                continue;
            }

            let timeoutExpired = false;
            if (job.status === "RUNNING" || job.status === "VERIFYING") {
                const attempts = await this.listAttemptsForJobIO(job.id);
                const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
                const startedAt = lastAttempt?.startedAt;
                const timeoutMs = job.timeoutMs;
                if (typeof startedAt === "number" && typeof timeoutMs === "number" && timeoutMs > 0) {
                    timeoutExpired = startedAt + timeoutMs <= now;
                }
            }

            if (timeoutExpired) {
                await this.runRecoveryOperationAsync({
                    jobId: job.id,
                    leaseId: lease.leaseId,
                    workerId: lease.workerId,
                    operationType: "TIMEOUT",
                    now,
                    body: async () => {
                        const live = await this.getJobIO(job.id);
                        if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                        if (live.status === "RETRY_SCHEDULED" || live.status === "DEAD_LETTER") return { ok: true };

                        if (live.status !== "FAILED") {
                            const failed = await this.recoverJobAtomicIO({
                                jobId: job.id,
                                expectedStatus: live.status,
                                newStatus: "FAILED",
                                expectedLeaseId: live.currentLeaseId ?? null,
                                event: { eventType: "execution.recovery.failed", payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, from: live.status, to: "FAILED", reason: "deadline_exceeded_during_lease_loss" } },
                                obligation: { leaseId: lease.leaseId, workerId: lease.workerId, reason: "TIMEOUT_ON_LEASE_LOSS" },
                            });
                            if (!failed.ok) {
                                const afterStep1 = await this.getJobIO(job.id);
                                if (!afterStep1 || afterStep1.status !== "FAILED") {
                                    return { ok: false, error: "TIMEOUT_STEP1_FAILED" };
                                }
                            }
                        }

                        this.__testPhase144Hook?.("afterTimeoutFailed");
                        const afterStep1 = await this.getJobIO(job.id);
                        if (!afterStep1 || afterStep1.status !== "FAILED") {
                            return { ok: false, error: "TIMEOUT_STEP1_STATE_DRIFT" };
                        }
                        const attemptsUsedT = (await this.listAttemptsForJobIO(job.id)).length;
                        const canRetry = this.recoveryCanRetry(afterStep1, "FAILED", "RETRY_SCHEDULED", attemptsUsedT);
                        const nextStatus = canRetry ? "RETRY_SCHEDULED" : "DEAD_LETTER";
                        const routed = await this.recoverJobAtomicIO({
                            jobId: job.id,
                            expectedStatus: "FAILED",
                            newStatus: nextStatus as any,
                            expectedLeaseId: null,
                            patch: { nextAttemptAt: canRetry ? now : null } as any,
                            event: { eventType: "execution.recovery.rerouted", payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, from: "FAILED", to: nextStatus, reason: "deadline_exceeded_during_lease_loss" } },
                        });
                        if (routed.ok) return { ok: true };
                        const afterStep2 = await this.getJobIO(job.id);
                        if (afterStep2 && (afterStep2.status === "RETRY_SCHEDULED" || afterStep2.status === "DEAD_LETTER")) {
                            return { ok: true };
                        }
                        return { ok: false, error: "TIMEOUT_STEP2_FAILED" };
                    },
                });

                const finalJob = await this.getJobIO(job.id);
                try {
                    this.fireAndForget(this.deps.events?.emit({
                        type: "execution.recovery_completed",
                        source: "ExecutionEngine",
                        execution_id: job.id,
                        payload: {
                            jobId: job.id,
                            leaseId: lease.leaseId,
                            workerId: lease.workerId,
                            classification: "TIMEOUT",
                            newStatus: finalJob?.status ?? job.status,
                            reason: "deadline_exceeded_during_lease_loss",
                        },
                    }));
                } catch { /* isolated */ }
                continue;
            }

            await this.runRecoveryOperationAsync({
                jobId: job.id,
                leaseId: lease.leaseId,
                workerId: lease.workerId,
                operationType: "ORPHAN_RECOVERY",
                now,
                body: async () => {
                    const live = await this.getJobIO(job.id);
                    if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                    if (live.status === "QUEUED") return { ok: true };

                    if (live.status !== "ORPHANED") {
                        const orphan = await this.recoverJobAtomicIO({
                            jobId: job.id,
                            expectedStatus: live.status,
                            newStatus: "ORPHANED",
                            expectedLeaseId: live.currentLeaseId ?? null,
                            event: { eventType: "execution.recovery.orphaned", payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, from: live.status, to: "ORPHANED" } },
                            obligation: { leaseId: lease.leaseId, workerId: lease.workerId, reason: "LEASE_EXPIRED" },
                        });
                        if (!orphan.ok) {
                            const afterStep1 = await this.getJobIO(job.id);
                            if (!afterStep1 || afterStep1.status !== "ORPHANED") {
                                return { ok: false, error: "ORPHAN_STEP1_FAILED" };
                            }
                        }
                    }

                    this.__testPhase144Hook?.("afterOrphaned");
                    const afterStep1 = await this.getJobIO(job.id);
                    if (!afterStep1 || afterStep1.status !== "ORPHANED") {
                        return { ok: false, error: "ORPHAN_STEP1_STATE_DRIFT" };
                    }
                    const attemptsUsedO = (await this.listAttemptsForJobIO(job.id)).length;
                    const canRetry = this.recoveryCanRetry(afterStep1, "ORPHANED", "QUEUED", attemptsUsedO);
                    if (!canRetry) return { ok: false, recoveryRequired: "NON_RETRYABLE_ORPHAN" };

                    const requeue = await this.recoverJobAtomicIO({
                        jobId: job.id,
                        expectedStatus: "ORPHANED",
                        newStatus: "QUEUED",
                        expectedLeaseId: null,
                        patch: { nextAttemptAt: now } as any,
                        event: { eventType: "execution.recovery.requeued", payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, from: "ORPHANED", to: "QUEUED" } },
                    });
                    if (requeue.ok) return { ok: true };
                    const afterStep2 = await this.getJobIO(job.id);
                    if (afterStep2 && afterStep2.status === "QUEUED") return { ok: true };
                    return { ok: false, error: "ORPHAN_STEP2_FAILED" };
                },
            });

            const finalJob = await this.getJobIO(job.id);
            try {
                if (finalJob?.status === "QUEUED") {
                    this.fireAndForget(this.deps.events?.emit({
                        type: "execution.recovery_completed",
                        source: "ExecutionEngine",
                        execution_id: job.id,
                        payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, classification: "RECOVERABLE", newStatus: "QUEUED" },
                    }));
                } else if (finalJob?.status === "ORPHANED") {
                    this.fireAndForget(this.deps.events?.emit({
                        type: "execution.recovery_required",
                        source: "ExecutionEngine",
                        execution_id: job.id,
                        payload: { jobId: job.id, leaseId: lease.leaseId, workerId: lease.workerId, classification: "RECOVERY_REQUIRED" },
                    }));
                }
                this.fireAndForget(this.deps.audit?.record({
                    actor: "system",
                    action: "execution.stale_recovered",
                    resource_type: "execution_job",
                    resource_id: job.id,
                    result: finalJob?.status === "QUEUED" ? "ok" : "blocked",
                    metadata: {
                        leaseId: lease.leaseId,
                        workerId: lease.workerId,
                        classification: finalJob?.status === "QUEUED" ? "RECOVERABLE" : "RECOVERY_REQUIRED",
                    },
                }));
            } catch { /* isolated */ }
        }

        const lostWorkers = await this.detectLostWorkersIO(now, 120000);
        for (const worker of lostWorkers) {
            worker.status = "LOST";
            if (this.store.hasAsyncBackend()) { await this.store.updateWorkerAsync(worker); } else { this.store.updateWorker(worker); }
            try {
                this.fireAndForget(this.deps.events?.emit({
                    type: "execution.worker_lost",
                    source: "ExecutionEngine",
                    payload: {
                        workerId: worker.workerId,
                        lastHeartbeatAt: worker.lastHeartbeatAt ?? null,
                        detectedAt: now,
                    },
                }));
            } catch { /* isolated */ }
        }
        // Phase 184: retry scheduling remains sync-SQLite. In shared mode
        // this is a separate boundary; verified by D11. Stale-lease recovery
        // above is what D09/D10 verify.
        if (!this.store.hasAsyncBackend()) {
            this.runDueRetries(now - 1);
            this.promoteImmediateRecoveryRetries(now, preExistingRetryScheduledJobIds);
        }
    }

    reconcileExecutionRecoveryOperations(now: number = Date.now(), limit: number = Infinity): void {
        if (this.shuttingDown) return;
        // Phase 184: shared mode cannot resume SQLite-side recovery operations.
        // The async op store does not expose listResumableOperations; stale-lease
        // recovery in shared mode is performed directly by recoverStaleJobs
        // against Postgres (verified by D09/D10).
        if (this.store.hasAsyncBackend()) return;
        const ops = this.store.recoveryOps;
        // Phase 159: bounded iteration. Default Infinity preserves prior behavior.
        // A production scheduler may pass a finite limit to cap per-tick work.
        const allCandidates = ops.listResumableOperations();
        const candidates = Number.isFinite(limit) && limit >= 0 ? allCandidates.slice(0, limit) : allCandidates;
        for (const op of candidates) {
            // Phase 145: a FAILED operation whose retry budget is exhausted
            // escalates to RECOVERY_REQUIRED rather than looping forever.
            if (op.state === "FAILED" && op.attemptCount >= 5) {
                const owner = this.recoveryOwnerId();
                const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                if (claim.claimed) {
                    ops.markRecoveryRequired(
                        op.operationId, owner,
                        "MAX_RECOVERY_ATTEMPTS_EXCEEDED_5: " + (op.lastError ?? "UNKNOWN"),
                        now
                    );
                }
                continue;
            }

            const job = this.store.getJob(op.jobId);
            if (!job) {
                const owner = this.recoveryOwnerId();
                const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "JOB_NOT_FOUND_DURING_RECONCILE", now);
                continue;
            }
            const leaseId = op.leaseId ?? "";
            const workerId = op.workerId ?? "";

            if (op.operationType === "CANCELLATION") {
                if (job.status === "CANCELLED") {
                    ops.finalizeCompletedOperation(op.operationId, now);
                    continue;
                }
                if (job.cancellationRequested &&
                    (job.status === "RUNNING" || job.status === "CLAIMED" ||
                     job.status === "VERIFYING" || job.status === "CANCELLATION_REQUESTED")) {
                    this.runRecoveryOperation({
                        jobId: job.id, leaseId, workerId,
                        operationType: "CANCELLATION", now,
                        body: () => {
                            const live = this.store.getJob(job.id);
                            if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                            const result = this.store.recoverJobAtomic({
                                jobId: job.id,
                                expectedStatus: live.status,
                                newStatus: "CANCELLED",
                                expectedLeaseId: live.currentLeaseId ?? null,
                                event: { eventType: "execution.recovery.cancelled", payload: { jobId: job.id, from: live.status, to: "CANCELLED", reason: "reconcile_cancellation" } },
                                obligation: { leaseId, workerId, reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
                            });
                            if (result.ok) return { ok: true };
                            const after = this.store.getJob(job.id);
                            if (after?.status === "CANCELLED") return { ok: true };
                            return { ok: false, error: "RECONCILE_CANCELLATION_FAILED" };
                        },
                    });
                    continue;
                }
                const owner = this.recoveryOwnerId();
                const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "INCONSISTENT_JOB_STATE_" + job.status, now);
                continue;
            }

            if (op.operationType === "TIMEOUT") {
                if (job.status === "RETRY_SCHEDULED" || job.status === "DEAD_LETTER") {
                    ops.finalizeCompletedOperation(op.operationId, now);
                    continue;
                }
                if (job.status === "FAILED") {
                    this.runRecoveryOperation({
                        jobId: job.id, leaseId, workerId,
                        operationType: "TIMEOUT", now,
                        body: () => {
                            const live = this.store.getJob(job.id);
                            if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                            if (live.status === "RETRY_SCHEDULED" || live.status === "DEAD_LETTER") return { ok: true };
                            if (live.status !== "FAILED") return { ok: false, error: "UNEXPECTED_" + live.status };
                            const canRetry = this.recoveryCanRetry(live, "FAILED", "RETRY_SCHEDULED");
                            const nextStatus = canRetry ? "RETRY_SCHEDULED" : "DEAD_LETTER";
                            const routed = this.store.recoverJobAtomic({
                                jobId: job.id,
                                expectedStatus: "FAILED",
                                newStatus: nextStatus as any,
                                expectedLeaseId: null,
                                patch: { nextAttemptAt: canRetry ? now : null } as any,
                                event: { eventType: "execution.recovery.rerouted", payload: { jobId: job.id, from: "FAILED", to: nextStatus, reason: "reconcile_timeout_step2" } },
                            });
                            if (routed.ok) return { ok: true };
                            const after = this.store.getJob(job.id);
                            if (after && (after.status === "RETRY_SCHEDULED" || after.status === "DEAD_LETTER")) return { ok: true };
                            return { ok: false, error: "RECONCILE_TIMEOUT_STEP2_FAILED" };
                        },
                    });
                    continue;
                }
                if (job.status === "RUNNING" || job.status === "VERIFYING" || job.status === "CLAIMED") {
                    this.runRecoveryOperation({
                        jobId: job.id, leaseId, workerId,
                        operationType: "TIMEOUT", now,
                        body: () => {
                            const live = this.store.getJob(job.id);
                            if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                            if (live.status !== "RUNNING" && live.status !== "VERIFYING" && live.status !== "CLAIMED") {
                                return { ok: false, error: "UNEXPECTED_" + live.status };
                            }
                            const failed = this.store.recoverJobAtomic({
                                jobId: job.id,
                                expectedStatus: live.status,
                                newStatus: "FAILED",
                                expectedLeaseId: live.currentLeaseId ?? null,
                                event: { eventType: "execution.recovery.failed", payload: { jobId: job.id, from: live.status, to: "FAILED", reason: "reconcile_timeout_step1" } },
                                obligation: { leaseId, workerId, reason: "TIMEOUT_ON_LEASE_LOSS" },
                            });
                            if (failed.ok) return { ok: true };
                            const after = this.store.getJob(job.id);
                            if (after?.status === "FAILED") return { ok: true };
                            return { ok: false, error: "RECONCILE_TIMEOUT_STEP1_FAILED" };
                        },
                    });
                    continue;
                }
                const owner = this.recoveryOwnerId();
                const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "INCONSISTENT_JOB_STATE_" + job.status, now);
                continue;
            }

            if (op.operationType === "ORPHAN_RECOVERY") {
                if (job.status === "QUEUED") {
                    ops.finalizeCompletedOperation(op.operationId, now);
                    continue;
                }
                if (job.status === "ORPHANED") {
                    const canRetry = this.recoveryCanRetry(job, "ORPHANED", "QUEUED");
                    if (!canRetry) {
                        const owner = this.recoveryOwnerId();
                        const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                        if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "NON_RETRYABLE_ORPHAN", now);
                        continue;
                    }
                    this.runRecoveryOperation({
                        jobId: job.id, leaseId, workerId,
                        operationType: "ORPHAN_RECOVERY", now,
                        body: () => {
                            const live = this.store.getJob(job.id);
                            if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                            if (live.status === "QUEUED") return { ok: true };
                            if (live.status !== "ORPHANED") return { ok: false, error: "UNEXPECTED_" + live.status };
                            const requeue = this.store.recoverJobAtomic({
                                jobId: job.id,
                                expectedStatus: "ORPHANED",
                                newStatus: "QUEUED",
                                expectedLeaseId: null,
                                patch: { nextAttemptAt: now } as any,
                                event: { eventType: "execution.recovery.requeued", payload: { jobId: job.id, from: "ORPHANED", to: "QUEUED", reason: "reconcile_orphan_step2" } },
                            });
                            if (requeue.ok) return { ok: true };
                            const after = this.store.getJob(job.id);
                            if (after?.status === "QUEUED") return { ok: true };
                            return { ok: false, error: "RECONCILE_ORPHAN_STEP2_FAILED" };
                        },
                    });
                    continue;
                }
                if (job.status === "RUNNING" || job.status === "CLAIMED" ||
                    job.status === "VERIFYING" || job.status === "CANCELLATION_REQUESTED") {
                    this.runRecoveryOperation({
                        jobId: job.id, leaseId, workerId,
                        operationType: "ORPHAN_RECOVERY", now,
                        body: () => {
                            const live = this.store.getJob(job.id);
                            if (!live) return { ok: false, error: "JOB_NOT_FOUND" };
                            if (live.status === "QUEUED") return { ok: true };

                            if (live.status !== "ORPHANED") {
                                if (live.status !== "RUNNING" && live.status !== "CLAIMED" &&
                                    live.status !== "VERIFYING" && live.status !== "CANCELLATION_REQUESTED") {
                                    return { ok: false, error: "UNEXPECTED_" + live.status };
                                }
                                const orphan = this.store.recoverJobAtomic({
                                    jobId: job.id,
                                    expectedStatus: live.status,
                                    newStatus: "ORPHANED",
                                    expectedLeaseId: live.currentLeaseId ?? null,
                                    event: { eventType: "execution.recovery.orphaned", payload: { jobId: job.id, from: live.status, to: "ORPHANED", reason: "reconcile_orphan_step1" } },
                                    obligation: { leaseId, workerId, reason: "LEASE_EXPIRED" },
                                });
                                if (!orphan.ok) {
                                    const after = this.store.getJob(job.id);
                                    if (!after || after.status !== "ORPHANED") {
                                        return { ok: false, error: "RECONCILE_ORPHAN_STEP1_FAILED" };
                                    }
                                }
                            }

                            const afterStep1 = this.store.getJob(job.id);
                            if (!afterStep1 || afterStep1.status !== "ORPHANED") {
                                return { ok: false, error: "RECONCILE_ORPHAN_STEP1_STATE_DRIFT" };
                            }
                            const canRetry = this.recoveryCanRetry(afterStep1, "ORPHANED", "QUEUED");
                            if (!canRetry) return { ok: false, recoveryRequired: "NON_RETRYABLE_ORPHAN" };

                            const requeue = this.store.recoverJobAtomic({
                                jobId: job.id,
                                expectedStatus: "ORPHANED",
                                newStatus: "QUEUED",
                                expectedLeaseId: null,
                                patch: { nextAttemptAt: now } as any,
                                event: { eventType: "execution.recovery.requeued", payload: { jobId: job.id, from: "ORPHANED", to: "QUEUED", reason: "reconcile_orphan_step2" } },
                            });
                            if (requeue.ok) return { ok: true };
                            const afterStep2 = this.store.getJob(job.id);
                            if (afterStep2?.status === "QUEUED") return { ok: true };
                            return { ok: false, error: "RECONCILE_ORPHAN_STEP2_FAILED" };
                        },
                    });
                    continue;
                }
                const owner = this.recoveryOwnerId();
                const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
                if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "INCONSISTENT_JOB_STATE_" + job.status, now);
                continue;
            }

            const owner = this.recoveryOwnerId();
            const claim = ops.claimOperation({ operationId: op.operationId, owner, durationMs: 60000, now });
            if (claim.claimed) ops.markRecoveryRequired(op.operationId, owner, "UNSUPPORTED_OPERATION_TYPE_" + op.operationType, now);
        }
    }
    requestCancellation(jobId: string): ExecutionJob | undefined {
        const job = this.store.getJob(jobId);
        if (!job) return undefined;
        const ok = this.store.requestCancellation(jobId);
        if (ok) {
            job.cancellationRequested = true;
            job.updatedAt = Date.now();

            // Phase 137: durable status transition. The flag alone is
            // discoverable, but transitioning RUNNING/VERIFYING to
            // CANCELLATION_REQUESTED makes the pending cancellation part of
            // the authoritative state machine so a fresh process can resume
            // it without relying on the (possibly dead) owning worker.
            const cur = this.store.getJob(jobId);
            if (cur && (cur.status === "RUNNING" || cur.status === "VERIFYING")) {
                try {
                    this.applyTransition(
                        jobId, "system", cur.status, "CANCELLATION_REQUESTED",
                        undefined, undefined, undefined,
                        "CANCELLATION_REQUESTED_BY_API"
                    );
                    const fresh = this.store.getJob(jobId);
                    if (fresh) { job.status = fresh.status; }
                } catch {
                    // Transition not permitted for this actor/state pair.
                    // The durable cancellation_requested flag remains the
                    // authoritative discovery mechanism for recoverStaleJobs.
                }
            }
        }        return job;
    }
}
