import { RemoteWorkerRegistry } from "./remote-worker-registry";
import { RemoteExecutionManager } from "./remote-execution-manager";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";
import { ExecutionAdapterRequest } from "./execution-adapter";

export class JobDispatcher {
  constructor(
    private workerRegistry: RemoteWorkerRegistry,
    private remoteManager: RemoteExecutionManager,
    private store: ExecutionStore,
    private leaseManager: LeaseManager
  ) {}

  async dispatchJob(jobId: string, workerId: string, request: ExecutionAdapterRequest): Promise<string> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const worker = this.workerRegistry.getWorker(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    if (worker.status !== "ONLINE" && worker.status !== "BUSY") {
      throw new Error(`Worker ${workerId} is not available`);
    }

    // Validate capabilities if operation requires
    const requiredOps = [request.operation];
    if (worker.capabilities?.operations) {
      const hasAll = requiredOps.every((op) => worker.capabilities!.operations!.includes(op));
      if (!hasAll) throw new Error(`Worker ${workerId} does not support ${request.operation}`);
    }

    // Acquire lease if not already owned by worker
    let lease = this.leaseManager.getActiveLeaseForJob(jobId);
    if (!lease) {
      lease = this.leaseManager.acquireLease(jobId, workerId, 60000);
    } else if (lease.workerId !== workerId) {
      throw new Error(`Lease for job ${jobId} is owned by another worker`);
    }

    // Mark worker busy
    this.workerRegistry.markBusy(workerId, jobId);

    try {
      const dispatch = await this.remoteManager.dispatch(request, workerId, lease.leaseId);
      return dispatch.dispatchId;
    } catch (err) {
      this.workerRegistry.markIdle(workerId);
      throw err;
    }
  }
}
