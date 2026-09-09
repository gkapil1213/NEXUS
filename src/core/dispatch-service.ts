import { ExecutionDispatchPort } from "./execution-dispatch-port";
import { JobDispatcher } from "./job-dispatcher";
import { RemoteExecutionManager } from "./remote-execution-manager";
import { ExecutionStore } from "./execution-store";
import { ExecutionJob, ExecutionAttempt, RemoteDispatchRecord } from "./execution-models";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export class DispatchService implements ExecutionDispatchPort {
    constructor(
        private jobDispatcher: JobDispatcher,
        private remoteManager: RemoteExecutionManager,
        private store: ExecutionStore
    ) {}

    async dispatch(job: ExecutionJob, attempt: ExecutionAttempt, leaseId: string, request: ExecutionAdapterRequest): Promise<{ dispatchId: string }> {
        const dispatchId = await this.jobDispatcher.dispatchJob(job.id, attempt.workerId!, request);
        const record: RemoteDispatchRecord = {
            dispatchId,
            jobId: job.id,
            attemptId: attempt.id,
            workerId: attempt.workerId!,
            leaseId: leaseId,
            idempotencyKey: job.idempotencyKey,
            status: "DISPATCHED",
            request: request,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.store.upsertRemoteDispatch(record);
        return { dispatchId };
    }

    async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
        const result = await this.remoteManager.collectResult(dispatchId);
        const record = this.store.getRemoteDispatch(dispatchId);
        if (record) {
            record.result = result;
            record.status = result.success ? "COMPLETED" : "FAILED";
            record.updatedAt = Date.now();
            this.store.upsertRemoteDispatch(record);
        }
        return result;
    }

    async cancel(dispatchId: string): Promise<void> {
        await this.remoteManager.cancel(dispatchId);
        const record = this.store.getRemoteDispatch(dispatchId);
        if (record) {
            record.status = "CANCELLED";
            record.updatedAt = Date.now();
            this.store.upsertRemoteDispatch(record);
        }
    }

    async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> {
        return this.remoteManager.getStatus(dispatchId);
    }
}
