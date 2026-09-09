import { ExecutionDispatchPort } from "./execution-dispatch-port";
import { JobDispatcher } from "./job-dispatcher";
import { RemoteExecutionManager } from "./remote-execution-manager";
import { ExecutionStore } from "./execution-store";
import { ExecutionJob, ExecutionAttempt, RemoteDispatchRecord } from "./execution-models";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

function generateInternalId(): string {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `dispatch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export class DispatchService implements ExecutionDispatchPort {
    constructor(
        private jobDispatcher: JobDispatcher,
        private remoteManager: RemoteExecutionManager,
        private store: ExecutionStore
    ) {}

    private async createOrGetDispatchRecord(
        job: ExecutionJob,
        attempt: ExecutionAttempt,
        leaseId: string,
        request: ExecutionAdapterRequest
    ): Promise<{ record: RemoteDispatchRecord; created: boolean }> {
        const existing = this.store.getRemoteDispatchByJobIdempotencyKey(job.idempotencyKey);

        if (existing) {
            return { record: existing, created: false };
        }

        const now = Date.now();
        const internalId = generateInternalId();

        const record: RemoteDispatchRecord = {
            dispatchId: internalId,
            jobId: job.id,
            attemptId: attempt.id,
            workerId: attempt.workerId!,
            leaseId: leaseId,
            idempotencyKey: job.idempotencyKey,
            status: "DISPATCH_INTENT",
            request,
            createdAt: now,
            updatedAt: now,
        };

        this.store.upsertRemoteDispatch(record);

        return { record, created: true };
    }

    async dispatch(
        job: ExecutionJob,
        attempt: ExecutionAttempt,
        leaseId: string,
        request: ExecutionAdapterRequest
    ): Promise<{ dispatchId: string }> {
        const { record, created } = await this.createOrGetDispatchRecord(
            job,
            attempt,
            leaseId,
            request
        );

        if (!created) {
            if (
                record.status === "DISPATCHED" ||
                record.status === "COMPLETED" ||
                record.status === "FAILED" ||
                record.status === "CANCELLED"
            ) {
                return { dispatchId: record.dispatchId };
            }

            if (record.status === "DISPATCH_INTENT") {
                throw new Error("Dispatch " + record.dispatchId + " has a persisted DISPATCH_INTENT and requires reconciliation before redispatch");
            }

            if (record.status === "UNKNOWN") {
                throw new Error("Dispatch " + record.dispatchId + " has UNKNOWN remote state and cannot be redispatched automatically");
            }

            throw new Error("Dispatch " + record.dispatchId + " is in unsupported state " + record.status);
        }

        const providerDispatchId = await this.jobDispatcher.dispatchJob(
            job.id,
            attempt.workerId!,
            request
        );

        const updated: RemoteDispatchRecord = {
            ...record,
            externalProviderId: providerDispatchId,
            status: "DISPATCHED",
            updatedAt: Date.now(),
        };

        this.store.upsertRemoteDispatch(updated);

        return { dispatchId: record.dispatchId };
    }
    async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
        const record = this.store.getRemoteDispatch(dispatchId);
        if (!record) throw new Error(`Dispatch ${dispatchId} not found`);

        // If result already persisted (e.g., after restart), return directly
        if (record.result) return record.result;

        const providerId = record.externalProviderId ?? dispatchId;
        const result = await this.remoteManager.collectResult(providerId);
        record.result = result;
        record.status = result.success ? "COMPLETED" : "FAILED";
        record.updatedAt = Date.now();
        this.store.upsertRemoteDispatch(record);
        return result;
    }

    async cancel(dispatchId: string): Promise<void> {
        const record = this.store.getRemoteDispatch(dispatchId);
        if (record && record.externalProviderId) {
            await this.remoteManager.cancel(record.externalProviderId);
        }
        if (record) {
            record.status = "CANCELLED";
            record.updatedAt = Date.now();
            this.store.upsertRemoteDispatch(record);
        }
    }

    async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> {
        const record = this.store.getRemoteDispatch(dispatchId);
        if (record?.externalProviderId) {
            return this.remoteManager.getStatus(record.externalProviderId);
        }
        throw new Error(`Dispatch ${dispatchId} not found`);
    }
}
