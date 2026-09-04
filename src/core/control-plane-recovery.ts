import { RemoteWorkerStore } from "./remote-worker-store";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";

export class ControlPlaneRecovery {
  constructor(
    private workerStore: RemoteWorkerStore,
    private executionStore: ExecutionStore,
    private leaseManager: LeaseManager
  ) {}

  recover(now: number = Date.now()): void {
    // 1. Recover expired leases
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
      }
    }

    // 2. Mark workers with stale heartbeats as offline/unhealthy
    const workers = this.workerStore.listWorkers();
    for (const worker of workers) {
      if (worker.status !== "REVOKED" && worker.lastHeartbeatAt !== undefined) {
        if (now - worker.lastHeartbeatAt > 120000) {
          worker.status = worker.status === "BUSY" ? "UNHEALTHY" : "OFFLINE";
          this.workerStore.updateWorker(worker);
        }
      }
    }
  }
}
