import { ExecutionStore } from "./execution-store";
import { ExecutionWorker, WorkerStatus } from "./execution-models";

export class WorkerRegistry {
  constructor(private store: ExecutionStore) {}

  register(worker: ExecutionWorker): void {
    if (this.store.getWorker(worker.workerId)) {
      this.store.updateWorker(worker);
    } else {
      this.store.registerWorker(worker);
    }
  }

  heartbeat(workerId: string, currentJobId?: string, now: number = Date.now()): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.lastHeartbeatAt = now;
    if (currentJobId !== undefined) worker.currentJobId = currentJobId;
    worker.status = currentJobId ? "BUSY" : "ONLINE";
    this.store.updateWorker(worker);
  }

  markBusy(workerId: string, jobId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "BUSY";
    worker.currentJobId = jobId;
    this.store.updateWorker(worker);
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
