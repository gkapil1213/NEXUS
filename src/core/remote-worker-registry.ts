import { RemoteWorkerStore } from "./remote-worker-store";
import { WorkerAuthentication } from "./worker-authentication";
import { RemoteWorker, RemoteWorkerStatus, WorkerAuthenticationResult } from "./remote-worker-models";

export class RemoteWorkerRegistry {
  constructor(
    private store: RemoteWorkerStore,
    private auth: WorkerAuthentication
  ) {}

  registerWorker(worker: RemoteWorker): void {
    const existing = this.store.getWorker(worker.workerId);
    if (existing) {
      throw new Error(`Worker ${worker.workerId} already registered`);
    }
    this.store.registerWorker(worker);
  }

  authenticate(workerId: string, credential: string, nonce?: string, timestamp?: number): WorkerAuthenticationResult {
    return this.auth.authenticate({ workerId, credential, nonce, timestamp });
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

  drainWorker(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    worker.status = "DRAINING";
    this.store.updateWorker(worker);
  }

  revokeWorker(workerId: string): void {
    this.store.revokeWorker(workerId);
  }

  recoverWorker(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (worker && (worker.status === "OFFLINE" || worker.status === "UNHEALTHY")) {
      worker.status = "ONLINE";
      worker.currentJobId = undefined;
      this.store.updateWorker(worker);
    }
  }

  listWorkers(status?: RemoteWorkerStatus): RemoteWorker[] {
    return status ? this.store.listWorkersByStatus(status) : this.store.listWorkers();
  }

  getWorker(workerId: string): RemoteWorker | undefined {
    return this.store.getWorker(workerId);
  }
}
