import Database from "better-sqlite3";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";
import { WorkerHealthStore } from "./worker-health";
import { RemoteWorkerStore } from "./remote-worker-store";
import { WorkerSessionStore } from "./worker-session-store";

export interface RecoveryDecision {
  action: "RETRY" | "QUARANTINE" | "DEAD_LETTER" | "NOOP";
  reason: string;
}

export class WorkerRecoveryService {
  constructor(
    private db: Database.Database,
    private workerStore: RemoteWorkerStore,
    private sessionStore: WorkerSessionStore,
    private executionStore: ExecutionStore,
    private leaseManager: LeaseManager,
    private healthStore: WorkerHealthStore
  ) {}

  private async recordRecovery(record: {
    recoveryId: string;
    workerId: string;
    jobId?: string;
    attemptId?: string;
    leaseId?: string;
    reason: string;
    decision: string;
    status: string;
    idempotencyKey: string;
    startedAt: number;
    completedAt?: number;
    error?: string;
    evidence?: any;
  }): Promise<void> {
    try {
      this.db.prepare(`
        INSERT INTO worker_recovery_attempts (
          recovery_id, worker_id, job_id, attempt_id, lease_id,
          reason, decision, status, idempotency_key,
          started_at, completed_at, error, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.recoveryId,
        record.workerId,
        record.jobId,
        record.attemptId,
        record.leaseId,
        record.reason,
        record.decision,
        record.status,
        record.idempotencyKey,
        record.startedAt,
        record.completedAt,
        record.error,
        record.evidence ? JSON.stringify(record.evidence) : null
      );
    } catch (err: any) {
      // If UNIQUE violation, ignore; used for duplicate protection
      if (!err.message?.includes("UNIQUE")) throw err;
    }
  }

  private isDuplicateRecovery(idempotencyKey: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM worker_recovery_attempts WHERE idempotency_key = ?").get(idempotencyKey);
    return !!row;
  }

  async recoverWorker(workerId: string, reason: string, idempotencyKey: string): Promise<{ status: string; action: RecoveryDecision["action"] }> {
    // Duplicate recovery protection
    if (this.isDuplicateRecovery(idempotencyKey)) {
      return { status: "DUPLICATE", action: "NOOP" };
    }

    const worker = this.workerStore.getWorker(workerId);
    if (!worker) return { status: "FAILED", action: "NOOP" };
    if (worker.status === "REVOKED") return { status: "REJECTED", action: "NOOP" };

    // Quarantine worker to prevent new work
    worker.status = "UNHEALTHY";
    this.workerStore.updateWorker(worker);

    // Invalidate sessions
    const activeSession = this.sessionStore.getActiveSessionForWorker(workerId);
    if (activeSession) this.sessionStore.markRevoked(activeSession.sessionId);

    // Find active lease / job
    const lease = this.leaseManager.getActiveLeaseForJob(worker.currentJobId || "");
    if (lease) {
      // Expire the lease
      this.leaseManager.expireLease(lease.leaseId);
      const job = this.executionStore.getJob(lease.jobId);
      if (job) {
        // Determine retry eligibility
        if (job.retryPolicy && !job.cancellationRequested) {
          const attempts = this.executionStore.listAttemptsForJob(job.id);
          if (attempts.length < job.retryPolicy.maxAttempts) {
            job.status = "RETRY_SCHEDULED";
            job.nextAttemptAt = Date.now();
            job.updatedAt = Date.now();
            this.executionStore.updateJob(job);
            await this.recordRecovery({
              recoveryId: `rec_${idempotencyKey}`,
              workerId,
              jobId: job.id,
              leaseId: lease.leaseId,
              reason,
              decision: "RETRY",
              status: "COMPLETED",
              idempotencyKey,
              startedAt: Date.now(),
              completedAt: Date.now(),
              evidence: { leaseId: lease.leaseId },
            });
            this.healthStore.recordHealthEvent({
              eventId: `re_${job.id}_${Date.now()}`,
              workerId,
              eventType: "RECOVERY_COMPLETED",
              payload: { jobId: job.id, action: "RETRY" },
              createdAt: Date.now(),
            });
            return { status: "RETRY_SCHEDULED", action: "RETRY" };
          } else {
            job.status = "DEAD_LETTER";
            this.executionStore.updateJob(job);
            await this.recordRecovery({
              recoveryId: `rec_${idempotencyKey}`,
              workerId,
              jobId: job.id,
              leaseId: lease.leaseId,
              reason,
              decision: "DEAD_LETTER",
              status: "COMPLETED",
              idempotencyKey,
              startedAt: Date.now(),
              completedAt: Date.now(),
            });
            return { status: "DEAD_LETTER", action: "DEAD_LETTER" };
          }
        } else {
          job.status = "DEAD_LETTER";
          this.executionStore.updateJob(job);
          await this.recordRecovery({
            recoveryId: `rec_${idempotencyKey}`,
            workerId,
            jobId: job.id,
            leaseId: lease.leaseId,
            reason,
            decision: "DEAD_LETTER",
            status: "COMPLETED",
            idempotencyKey,
            startedAt: Date.now(),
            completedAt: Date.now(),
          });
          return { status: "DEAD_LETTER", action: "DEAD_LETTER" };
        }
      }
    }

    // No active job: mark worker for quarantine
    this.healthStore.upsertHealth({
      workerId,
      healthState: "QUARANTINED",
      lastHeartbeatAt: worker.lastHeartbeatAt,
      heartbeatFailures: 0,
      updatedAt: Date.now(),
      detectedAt: Date.now(),
    });
    await this.recordRecovery({
      recoveryId: `rec_${idempotencyKey}`,
      workerId,
      reason,
      decision: "QUARANTINE",
      status: "COMPLETED",
      idempotencyKey,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    return { status: "QUARANTINED", action: "QUARANTINE" };
  }
}
