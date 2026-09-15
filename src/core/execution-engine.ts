
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
     * affects zero rows — we do NOT overwrite the new owner's state.
     *
     * On ownership loss we:
     *   1. write a durable ownership-loss obligation (idempotent per job+lease)
     *   2. emit `execution.ownership_lost` (best-effort)
     *   3. write an audit record (best-effort)
     *   4. throw OwnershipLostError — deterministic, not silent
     */
    private persistAsOwner(job: ExecutionJob, workerId: string, leaseId: string): void {
        const result = this.store.updateJobAsOwner(job, workerId, leaseId);
        if (result.updated) return;

        let obligationId = "unknown";
        try {
            const ob = this.store.writeOwnershipObligation({
                jobId: job.id,
                leaseId,
                workerId,
                reason: result.reason ?? "WORKER_OWNERSHIP_LOST",
            });
            obligationId = ob.obligationId;
        } catch { /* obligation failure does not mask the ownership loss */ }

        try {
            this.fireAndForget(this.deps.events?.emit({
                type: "execution.ownership_lost",
                source: "ExecutionEngine",
                execution_id: job.id,
                payload: { jobId: job.id, leaseId, workerId, obligationId },
            }));
        } catch { /* isolated */ }

        try {
            this.fireAndForget(this.deps.audit?.record({
                actor: workerId,
                action: "execution.ownership_lost",
                resource_type: "execution_job",
                resource_id: job.id,
                result: "blocked",
                metadata: { leaseId, obligationId },
            }));
        } catch { /* isolated */ }

        throw new OwnershipLostError(job.id, leaseId, workerId);
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
            try {
                const lease = this.leaseManager.acquireLease(job.id, workerId, 60000);
                job.status = "CLAIMED";
                job.currentLeaseId = lease.leaseId;
                job.updatedAt = Date.now();
                this.store.updateJob(job);
                this.workerRegistry.markBusy(workerId, job.id);
                return { job, lease };
            } catch {
                continue;
            }
        }
        return null;
    }

    async executeJob(workerId: string, jobId: string, leaseId: string): Promise<ExecutionJob> {
        const job = this.store.getJob(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);

        if (!this.leaseManager.validateLease(leaseId, workerId)) {
            // Phase 126: ownership already lost.  Do NOT clobber the job row —
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

        this.stateMachine.assertTransition(job.status, "RUNNING");
        job.status = "RUNNING";
        job.updatedAt = Date.now();
        this.persistAsOwner(job, workerId, leaseId);

        const attemptNumber = this.store.listAttemptsForJob(jobId).length + 1;
        const attemptId = `attempt_${jobId}_${attemptNumber}`;
        const attempt: ExecutionAttempt = {
            id: attemptId,
            jobId,
            attemptNumber,
            status: "RUNNING",
            workerId,
            leaseId,
            startedAt: Date.now(),
            createdAt: Date.now(),
        };
        this.store.createAttempt(attempt);

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
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                this.persistAsOwner(job, workerId, leaseId);
                this.leaseManager.releaseLease(leaseId);
            job.currentLeaseId = undefined;
        job.currentLeaseId = undefined;
                this.workerRegistry.markIdle(workerId);
                return job;
            }
            if (decision === "APPROVAL_REQUIRED") {
                job.status = "APPROVAL_REQUIRED" as any;
                job.updatedAt = Date.now();
                this.persistAsOwner(job, workerId, leaseId);
                this.leaseManager.releaseLease(leaseId);
            job.currentLeaseId = undefined;
        job.currentLeaseId = undefined;
                this.workerRegistry.markIdle(workerId);
                return job;
            }
        }

        if (this.deps.safety) {
            const safetyResult = await this.deps.safety.verify(job, workerId, leaseId);
            if (!safetyResult.safe) {
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                this.persistAsOwner(job, workerId, leaseId);
                this.leaseManager.releaseLease(leaseId);
            job.currentLeaseId = undefined;
        job.currentLeaseId = undefined;
                this.workerRegistry.markIdle(workerId);
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

        if (job.cancellationRequested) {
            attempt.status = "CANCELLED";
            attempt.evidence = ["Execution cancelled after completion"];
            this.store.updateAttempt(attempt);
            job.cancellationAcknowledged = true;
            job.status = "CANCELLED";
            job.updatedAt = Date.now();
            this.persistAsOwner(job, workerId, leaseId);
            this.leaseManager.releaseLease(leaseId);
            this.workerRegistry.markIdle(workerId);
            return job;
        }

        if (!executionResult || !executionResult.success) {
            attempt.status = "FAILED";
            attempt.error = executionError || "Execution failed";
            this.store.updateAttempt(attempt);

            if (job.cancellationRequested) {
                job.status = "CANCELLED";
                job.cancellationAcknowledged = true;
                job.updatedAt = Date.now();
                this.persistAsOwner(job, workerId, leaseId);
                this.leaseManager.releaseLease(leaseId);
            job.currentLeaseId = undefined;
        job.currentLeaseId = undefined;
                this.workerRegistry.markIdle(workerId);
                return job;
            }

            if (timedOut && job.retryPolicy) {
                const nextAttempt = this.retryEngine.calculateNextAttempt(attemptNumber, job.retryPolicy, Date.now());
                if (nextAttempt !== null) {
                    job.status = "RETRY_SCHEDULED";
                    job.nextAttemptAt = nextAttempt;
                } else {
                    job.status = "DEAD_LETTER";
                }
            } else if (job.retryPolicy && this.retryEngine.isRetryable(executionError || "Execution failed", job.retryPolicy)) {
                const nextAttempt = this.retryEngine.calculateNextAttempt(attemptNumber, job.retryPolicy, Date.now());
                if (nextAttempt !== null) {
                    job.status = "RETRY_SCHEDULED";
                    job.nextAttemptAt = nextAttempt;
                } else {
                    job.status = "DEAD_LETTER";
                }
            } else {
                job.status = "DEAD_LETTER";
            }
            job.updatedAt = Date.now();
            this.persistAsOwner(job, workerId, leaseId);
            this.leaseManager.releaseLease(leaseId);
            job.currentLeaseId = undefined;
        job.currentLeaseId = undefined;
            this.workerRegistry.markIdle(workerId);
            return job;
        }

        let verificationSuccess = true;
        if (this.deps.verification) {
            this.stateMachine.assertTransition(job.status, "VERIFYING");
            job.status = "VERIFYING";
            job.updatedAt = Date.now();
            this.persistAsOwner(job, workerId, leaseId);

            try {
                verificationSuccess = await this.deps.verification(job, executionResult);
            } catch (err: any) {
                verificationSuccess = false;
                attempt.error = `Verification failed: ${err.message}`;
            }
            attempt.status = verificationSuccess ? "SUCCEEDED" : "FAILED";
            attempt.evidence = [verificationSuccess ? "Verification succeeded" : "Verification failed"];
        } else {
            attempt.status = "SUCCEEDED";
            attempt.evidence = ["Execution succeeded (verification not configured)"];
        }

        attempt.completedAt = Date.now();
        this.store.updateAttempt(attempt);

        job.status = attempt.status as ExecutionJobStatus;
        job.updatedAt = Date.now();
        this.persistAsOwner(job, workerId, leaseId);

        this.leaseManager.releaseLease(leaseId);
        job.currentLeaseId = undefined;
        this.workerRegistry.markIdle(workerId);

        return job;
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
    recoverStaleJobs(now: number = Date.now()): void {
        const expiredLeases = this.leaseManager.recoverExpiredLeases(now);
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

            const job = this.store.getJob(lease.jobId);
            if (!job) continue;

            // Terminal states are never resurrected.
            if (
                job.status === "SUCCEEDED" ||
                job.status === "FAILED" ||
                job.status === "CANCELLED" ||
                job.status === "DEAD_LETTER"
            ) {
                continue;
            }

            // Only jobs that could have been owned can be orphaned.
            if (job.status !== "RUNNING" && job.status !== "CLAIMED" && job.status !== "VERIFYING") {
                continue;
            }

            // Atomic: only applies if the job is still in its observed status
            // AND still owned by the same lease.  If a new worker took over
            // between recoverExpiredLeases() and here, this is a no-op.
            const orphaned = this.store.recoverJobToStatus(
                job.id,
                job.status,
                "ORPHANED",
                job.currentLeaseId ?? null,
                { now }
            );
            if (!orphaned) {
                // Another owner appeared concurrently — skip recovery for this
                // job.  The obligation was already written above; it remains
                // OPEN for the new owner or an operator to resolve.
                continue;
            }
            job.status = "ORPHANED";
            job.updatedAt = now;
            job.currentLeaseId = undefined;

            let obligationId = "unknown";
            try {
                const ob = this.store.writeOwnershipObligation({
                    jobId: job.id,
                    leaseId: lease.leaseId,
                    workerId: lease.workerId,
                    reason: "LEASE_EXPIRED",
                    now,
                });
                obligationId = ob.obligationId;
            } catch { /* obligation failure does not stop recovery */ }

            const canRetry =
                !!job.retryPolicy &&
                this.stateMachine.canTransition("ORPHANED", "QUEUED");

            if (canRetry) {
                const requeued = this.store.recoverJobToStatus(
                    job.id,
                    "ORPHANED",
                    "QUEUED",
                    null,
                    { nextAttemptAt: now, now }
                );
                if (!requeued) {
                    // Another writer got in — leave as ORPHANED and let the
                    // next recovery cycle pick it up.  No fake SUCCESS.
                    continue;
                }
                job.status = "QUEUED";
                job.nextAttemptAt = now;
                job.currentLeaseId = undefined;
                job.updatedAt = now;
                try {
                    this.fireAndForget(this.deps.events?.emit({
                        type: "execution.recovery_completed",
                        source: "ExecutionEngine",
                        execution_id: job.id,
                        payload: {
                            jobId: job.id,
                            leaseId: lease.leaseId,
                            workerId: lease.workerId,
                            obligationId,
                            classification: "RECOVERABLE",
                            newStatus: "QUEUED",
                        },
                    }));
                } catch { /* isolated */ }
            } else {
                try {
                    this.fireAndForget(this.deps.events?.emit({
                        type: "execution.recovery_required",
                        source: "ExecutionEngine",
                        execution_id: job.id,
                        payload: {
                            jobId: job.id,
                            leaseId: lease.leaseId,
                            workerId: lease.workerId,
                            obligationId,
                            classification: "RECOVERY_REQUIRED",
                        },
                    }));
                } catch { /* isolated */ }
            }

            try {
                this.fireAndForget(this.deps.audit?.record({
                    actor: "system",
                    action: "execution.stale_recovered",
                    resource_type: "execution_job",
                    resource_id: job.id,
                    result: canRetry ? "ok" : "blocked",
                    metadata: {
                        leaseId: lease.leaseId,
                        workerId: lease.workerId,
                        obligationId,
                        classification: canRetry ? "RECOVERABLE" : "RECOVERY_REQUIRED",
                    },
                }));
            } catch { /* isolated */ }
        }

        const lostWorkers = this.workerRegistry.detectLostWorkers(now, 120000);
        for (const worker of lostWorkers) {
            worker.status = "LOST";
            this.store.updateWorker(worker);
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
    }

    requestCancellation(jobId: string): ExecutionJob | undefined {
        const job = this.store.getJob(jobId);
        if (!job) return undefined;
        job.cancellationRequested = true;
        job.updatedAt = Date.now();
        this.store.updateJob(job);
        return job;
    }
}
