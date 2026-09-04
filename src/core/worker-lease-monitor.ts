import Database from "better-sqlite3";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";
import { WorkerHealthStore } from "./worker-health";

export class WorkerLeaseMonitor {
  constructor(
    private db: Database.Database,
    private executionStore: ExecutionStore,
    private leaseManager: LeaseManager,
    private healthStore: WorkerHealthStore
  ) {}

  monitorLeases(now: number = Date.now()): void {
    const expiredLeases = this.leaseManager.recoverExpiredLeases(now);
    for (const lease of expiredLeases) {
      const job = this.executionStore.getJob(lease.jobId);
      if (job && (job.status === "RUNNING" || job.status === "CLAIMED" || job.status === "VERIFYING")) {
        job.status = "ORPHANED";
        job.updatedAt = now;
        this.executionStore.updateJob(job);
        if (job.retryPolicy) {
          job.status = "RETRY_SCHEDULED";
          job.nextAttemptAt = now;
          this.executionStore.updateJob(job);
        }
        this.healthStore.recordHealthEvent({
          eventId: `lease_${lease.leaseId}_${now}`,
          workerId: lease.workerId,
          eventType: "LEASE_EXPIRED",
          payload: { leaseId: lease.leaseId, jobId: lease.jobId },
          createdAt: now,
        });
      }
    }
  }
}

