
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
export interface ExecutionDeps {
    dispatchPort?: ExecutionDispatchPort;
    governance?: {
        evaluate(job: ExecutionJob): Promise<"ALLOW" | "APPROVAL_REQUIRED" | "DENY" | "FREEZE">;
    };
    safety?: {
        verify(job: ExecutionJob, workerId: string, leaseId: string): Promise<{ safe: boolean; reason?: string }>;
    };
    verification?: (job: ExecutionJob, result: any) => Promise<boolean>;
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
            job.status = "ORPHANED";
            job.updatedAt = Date.now();
            this.store.updateJob(job);
            throw new Error("Lease lost or invalid");
        }

        this.stateMachine.assertTransition(job.status, "RUNNING");
        job.status = "RUNNING";
        job.updatedAt = Date.now();
        this.store.updateJob(job);

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
                this.store.updateJob(job);
                this.leaseManager.releaseLease(leaseId);
                this.workerRegistry.markIdle(workerId);
                return job;
            }
            if (decision === "APPROVAL_REQUIRED") {
                job.status = "APPROVAL_REQUIRED" as any;
                job.updatedAt = Date.now();
                this.store.updateJob(job);
                this.leaseManager.releaseLease(leaseId);
                this.workerRegistry.markIdle(workerId);
                return job;
            }
        }

        if (this.deps.safety) {
            const safetyResult = await this.deps.safety.verify(job, workerId, leaseId);
            if (!safetyResult.safe) {
                job.status = "BLOCKED";
                job.updatedAt = Date.now();
                this.store.updateJob(job);
                this.leaseManager.releaseLease(leaseId);
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

        if (!executionResult || !executionResult.success) {
            attempt.status = "FAILED";
            attempt.error = executionError || "Execution failed";
            this.store.updateAttempt(attempt);

            if (job.cancellationRequested) {
                job.status = "CANCELLED";
                job.cancellationAcknowledged = true;
                job.updatedAt = Date.now();
                this.store.updateJob(job);
                this.leaseManager.releaseLease(leaseId);
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
            this.store.updateJob(job);
            this.leaseManager.releaseLease(leaseId);
            this.workerRegistry.markIdle(workerId);
            return job;
        }

        let verificationSuccess = true;
        if (this.deps.verification) {
            this.stateMachine.assertTransition(job.status, "VERIFYING");
            job.status = "VERIFYING";
            job.updatedAt = Date.now();
            this.store.updateJob(job);

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
        this.store.updateJob(job);

        this.leaseManager.releaseLease(leaseId);
        this.workerRegistry.markIdle(workerId);

        return job;
    }

    recoverStaleJobs(now: number = Date.now()): void {
        const expiredLeases = this.leaseManager.recoverExpiredLeases(now);
        for (const lease of expiredLeases) {
            const job = this.store.getJob(lease.jobId);
            if (job && (job.status === "RUNNING" || job.status === "CLAIMED" || job.status === "VERIFYING")) {
                job.status = "ORPHANED";
                job.updatedAt = now;
                this.store.updateJob(job);
                if (job.retryPolicy) {
                    job.status = "RETRY_SCHEDULED";
                    job.nextAttemptAt = now;
                    this.store.updateJob(job);
                }
            }
        }
        const lostWorkers = this.workerRegistry.detectLostWorkers(now, 120000);
        for (const worker of lostWorkers) {
            worker.status = "LOST";
            this.store.updateWorker(worker);
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
