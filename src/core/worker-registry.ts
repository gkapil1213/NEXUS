import { ExecutionStore } from "./execution-store";
import { ExecutionWorker, WorkerStatus } from "./execution-models";
import type { LeaseManager } from "./lease-manager";

export class WorkerRegistry {
  constructor(
    private store: ExecutionStore,
    // Phase 126: optional — required only when heartbeat is asked to renew a lease.
    private leaseManager?: LeaseManager
  ) {}

  register(worker: ExecutionWorker): void {
    if (this.store.getWorker(worker.workerId)) {
      this.store.updateWorker(worker);
    } else {
      this.store.registerWorker(worker);
    }
  }

  /**
   * Phase 126: heartbeat optionally proves lease ownership before claiming health.
   * If `opts.leaseId` is supplied and lease renewal fails, `lastHeartbeatAt` is
   * NOT updated and the worker is NOT marked healthy.  Callers see an explicit
   * ownership-loss result and must stop protected execution mutations.
   */
  heartbeat(
    workerId: string,
    currentJobId?: string,
    opts?: { leaseId?: string; ttlMs?: number; now?: number }
  ): { healthy: boolean; reason?: "WORKER_OWNERSHIP_LOST" | "LEASE_MANAGER_MISSING" } {
    const now = opts?.now ?? Date.now();
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    if (opts?.leaseId) {
      if (!this.leaseManager) {
        return { healthy: false, reason: "LEASE_MANAGER_MISSING" };
      }
      try {
        this.leaseManager.renewLease(opts.leaseId, workerId, opts.ttlMs ?? 60000, now);
      } catch {
        return { healthy: false, reason: "WORKER_OWNERSHIP_LOST" };
      }
    }

    worker.lastHeartbeatAt = now;
    if (currentJobId !== undefined) worker.currentJobId = currentJobId;
    worker.status = currentJobId ? "BUSY" : "ONLINE";
    this.store.updateWorker(worker);
    return { healthy: true };
  }

  markBusy(workerId: string, jobId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "BUSY";
    worker.currentJobId = jobId;
    this.store.updateWorker(worker);
  }

  getWorker(workerId: string): ExecutionWorker | undefined {
    return this.store.getWorker(workerId);
  }

  markIdle(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "ONLINE";
    worker.currentJobId = undefined;
    this.store.updateWorker(worker);
  }

  drain(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "DRAINING";
    this.store.updateWorker(worker);
  }

  unregister(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (worker) {
      worker.status = "OFFLINE";
      this.store.updateWorker(worker);
    }
  }

  listWorkers(status?: WorkerStatus): ExecutionWorker[] {
    return status ? this.store.listWorkersByStatus(status) : this.store.listWorkers();
  }


  // ---------- Async variants -- Phase 183 final ----------
  // Only valid when store.hasAsyncBackend() is true (shared mode).
  // Mirrors the sync API shape; never falls back to SQLite.

  async registerAsync(worker: ExecutionWorker): Promise<void> {
    const existing = await this.store.getWorkerAsync(worker.workerId);
    if (existing) {
      await this.store.updateWorkerAsync(worker);
    } else {
      await this.store.registerWorkerAsync(worker);
    }
  }

  async heartbeatAsync(
    workerId: string,
    currentJobId?: string,
    opts?: { leaseId?: string; ttlMs?: number; now?: number },
  ): Promise<{ healthy: boolean; reason?: "WORKER_OWNERSHIP_LOST" | "LEASE_MANAGER_MISSING" }> {
    const now = opts?.now ?? Date.now();
    const worker = await this.store.getWorkerAsync(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    if (opts?.leaseId) {
      if (!this.leaseManager) return { healthy: false, reason: "LEASE_MANAGER_MISSING" };
      try {
        await this.leaseManager.renewLeaseAsync(opts.leaseId, workerId, opts.ttlMs ?? 60000, now);
      } catch {
        return { healthy: false, reason: "WORKER_OWNERSHIP_LOST" };
      }
    }

    worker.lastHeartbeatAt = now;
    if (currentJobId !== undefined) worker.currentJobId = currentJobId;
    worker.status = currentJobId ? "BUSY" : "ONLINE";
    await this.store.updateWorkerAsync(worker);
    return { healthy: true };
  }

  async getWorkerAsync(workerId: string): Promise<ExecutionWorker | undefined> {
    return this.store.getWorkerAsync(workerId);
  }

  async markBusyAsync(workerId: string, jobId: string): Promise<void> {
    const worker = await this.store.getWorkerAsync(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "BUSY";
    worker.currentJobId = jobId;
    await this.store.updateWorkerAsync(worker);
  }

  async markIdleAsync(workerId: string): Promise<void> {
    const worker = await this.store.getWorkerAsync(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "ONLINE";
    worker.currentJobId = undefined;
    await this.store.updateWorkerAsync(worker);
  }

  async drainAsync(workerId: string): Promise<void> {
    const worker = await this.store.getWorkerAsync(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "DRAINING";
    await this.store.updateWorkerAsync(worker);
  }

  async unregisterAsync(workerId: string): Promise<void> {
    const worker = await this.store.getWorkerAsync(workerId);
    if (worker) {
      worker.status = "OFFLINE";
      await this.store.updateWorkerAsync(worker);
    }
  }

  async listWorkersAsync(status?: WorkerStatus): Promise<ExecutionWorker[]> {
    return status ? this.store.listWorkersByStatusAsync(status) : this.store.listWorkersAsync();
  }

  async detectLostWorkersAsync(now: number, maxHeartbeatAgeMs: number): Promise<ExecutionWorker[]> {
    const workers = await this.store.listWorkersAsync();
    return workers.filter(
      (w) =>
        w.status !== "OFFLINE" &&
        w.lastHeartbeatAt !== undefined &&
        now - w.lastHeartbeatAt > maxHeartbeatAgeMs,
    );
  }
  detectLostWorkers(now: number, maxHeartbeatAgeMs: number): ExecutionWorker[] {
    const workers = this.store.listWorkers();
    return workers.filter(
      (w) =>
        w.status !== "OFFLINE" &&
        w.lastHeartbeatAt !== undefined &&
        now - w.lastHeartbeatAt > maxHeartbeatAgeMs
    );
  }
}
