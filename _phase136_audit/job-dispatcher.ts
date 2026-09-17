import { WorkerRegistry } from "./worker-registry";
import { RemoteExecutionManager } from "./remote-execution-manager";
import { ExecutionStore } from "./execution-store";
import { LeaseManager } from "./lease-manager";
import { ExecutionAdapterRequest } from "./execution-adapter";


export class JobDispatcher {
    constructor(
        private workerRegistry: WorkerRegistry,
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

        const requiredOps = [request.operation];
        const capabilities: any = worker.capabilities;
        const hasAll = Array.isArray(capabilities)
            ? requiredOps.every(op => capabilities.includes(op))
            : capabilities?.operations
                ? requiredOps.every(op => capabilities.operations.includes(op))
                : false;
        if (!hasAll) throw new Error(`Worker ${workerId} does not support ${request.operation}`);

        let lease = this.leaseManager.getActiveLeaseForJob(jobId);
        if (!lease) {
            lease = this.leaseManager.acquireLease(jobId, workerId, 60000);
        } else if (lease.workerId !== workerId) {
            throw new Error(`Lease for job ${jobId} is owned by another worker`);
        }

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
