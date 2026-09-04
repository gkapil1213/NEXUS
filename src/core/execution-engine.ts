import { ExecutionStore } from "./execution-store";
import { ExecutionStateMachine } from "./execution-state-machine";
import { WorkerRegistry } from "./worker-registry";
import { LeaseManager } from "./lease-manager";
import { RetryEngine } from "./retry-engine";
import {
  ExecutionJob,
  ExecutionAttempt,
  ExecutionJobStatus,
  RetryPolicy,
} from "./execution-models";

export interface ExecutionDeps {
  executionFn?: (job: ExecutionJob) => Promise<boolean>;
  verificationFn?: (job: ExecutionJob) => Promise<boolean>;
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
      id: `job_${now}_${Math.random().toString(36).slice(2)}`,
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

  async executeJob(
    workerId: string,
    jobId: string,
    leaseId: string
  ): Promise<ExecutionJob> {
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

    let executionSuccess = false;
    let errorMsg: string | undefined;
    let timedOut = false;

    try {
      if (this.deps.executionFn) {
        let execPromise = this.deps.executionFn(job);
        if (job.timeoutMs) {
          execPromise = withTimeout(execPromise, job.timeoutMs, `Execution timed out after ${job.timeoutMs}ms`);
        }
        executionSuccess = await execPromise;
      } else {
        errorMsg = "No execution function provided";
      }
    } catch (err: any) {
      errorMsg = err?.message || String(err);
      if (errorMsg && errorMsg.includes("timed out")) timedOut = true;
    }

    attempt.completedAt = Date.now();

    if (!executionSuccess) {
      attempt.status = "FAILED";
      attempt.error = errorMsg || "Execution failed";
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
      } else if (job.retryPolicy && this.retryEngine.isRetryable(errorMsg || "Execution failed", job.retryPolicy)) {
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

    if (this.deps.verificationFn) {
      this.stateMachine.assertTransition(job.status, "VERIFYING");
      job.status = "VERIFYING";
      job.updatedAt = Date.now();
      this.store.updateJob(job);

      let verified = false;
      try {
        let verifyPromise = this.deps.verificationFn(job);
        if (job.timeoutMs) {
          verifyPromise = withTimeout(verifyPromise, job.timeoutMs, `Verification timed out after ${job.timeoutMs}ms`);
        }
        verified = await verifyPromise;
      } catch (err: any) {
        attempt.error = `Verification failed: ${err?.message || String(err)}`;
        verified = false;
      }

      attempt.status = verified ? "SUCCEEDED" : "FAILED";
      attempt.evidence = [verified ? "Verification succeeded" : "Verification failed"];
    } else {
      attempt.status = "SUCCEEDED";
      attempt.evidence = ["Execution succeeded (no verification)"];
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
