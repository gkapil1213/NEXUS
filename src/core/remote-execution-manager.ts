import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";
import { ExecutionStore } from "./execution-store";
import { RemoteDispatchRecord } from "./execution-models";

export class RemoteExecutionManager {
    private dispatches = new Map<string, { adapter: RemoteExecutionAdapter; status: string }>();

    constructor(
        private adapter: RemoteExecutionAdapter,
        private store?: ExecutionStore
    ) {
        if (store) {
            this.reconcilePersistedDispatches(store.listAllRemoteDispatches());
        }
    }

    public async reconcilePersistedDispatches(records: RemoteDispatchRecord[]): Promise<void> {
        for (const record of records) {
            if (this.dispatches.has(record.dispatchId)) continue;

            // Terminal states are already durable; do not overwrite them.
            if (record.status === "COMPLETED" || record.status === "FAILED" || record.status === "CANCELLED") {
                this.dispatches.set(record.dispatchId, { adapter: this.adapter, status: record.status });
                continue;
            }

            let finalStatus: RemoteDispatchRecord["status"] = "UNKNOWN";
            try {
                const queryId = record.externalProviderId ?? record.dispatchId;
                const status = await this.adapter.getStatus(queryId);
                finalStatus = status.status as RemoteDispatchRecord["status"];
                this.dispatches.set(record.dispatchId, { adapter: this.adapter, status: status.status });
            } catch {
                this.dispatches.set(record.dispatchId, { adapter: this.adapter, status: "UNKNOWN" });
            }

            if (this.store) {
                const fresh = this.store.getRemoteDispatch(record.dispatchId);
                if (fresh) {
                    const updated: RemoteDispatchRecord = {
                        ...fresh,
                        status: finalStatus,
                        updatedAt: Date.now(),
                    };
                    this.store.upsertRemoteDispatch(updated);
                }
            }
        }
    }

    async dispatch(request: ExecutionAdapterRequest, workerId: string, leaseId: string): Promise<{ dispatchId: string }> {
        await this.adapter.connect();
        const result = await this.adapter.dispatch(request, workerId, leaseId);
        this.dispatches.set(result.dispatchId, { adapter: this.adapter, status: "DISPATCHED" });
        return result;
    }

    async cancel(dispatchId: string): Promise<void> {
        const entry = this.dispatches.get(dispatchId);
        if (!entry) throw new Error(`Dispatch ${dispatchId} not found`);
        await entry.adapter.cancel(dispatchId);
        entry.status = "CANCELLED";
    }

    async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> {
        const entry = this.dispatches.get(dispatchId);
        if (entry) return entry.adapter.getStatus(dispatchId);
        if (this.store) {
            const record = this.store.getRemoteDispatch(dispatchId);
            if (record) {
                if (record.result) return { status: record.result.success ? "COMPLETED" : "FAILED", evidence: record.result.evidence };
                if (record.status) return { status: record.status };
            }
        }
        throw new Error(`Dispatch ${dispatchId} not found`);
    }

    async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
        // Durable terminal results are authoritative across process restarts.
        // Never prefer an in-memory adapter result over a persisted result.
        if (this.store) {
            const record = this.store.getRemoteDispatch(dispatchId);
            if (record) {
                if (record.result) {
                    return record.result;
                }

                const providerId = record.externalProviderId ?? dispatchId;
                return this.adapter.collectResult(providerId);
            }
        }

        const entry = this.dispatches.get(dispatchId);
        if (entry) {
            return entry.adapter.collectResult(dispatchId);
        }

        throw new Error(`Dispatch ${dispatchId} not found`);
    }

    streamLogs(dispatchId: string) {
        const entry = this.dispatches.get(dispatchId);
        if (!entry) throw new Error(`Dispatch ${dispatchId} not found`);
        return entry.adapter.streamLogs(dispatchId);
    }
}
