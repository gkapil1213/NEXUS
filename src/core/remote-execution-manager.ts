import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";
import { ExecutionStore } from "./execution-store";
import { RemoteDispatchRecord } from "./execution-models";

export class RemoteExecutionManager {
    private dispatches = new Map<string, { adapter: RemoteExecutionAdapter; status: string }>();

    private initialized = false;
    private initPromise: Promise<void> | null = null;

    constructor(
        private adapter: RemoteExecutionAdapter,
        private store?: ExecutionStore
    ) {
        // Phase 300 / WP5: constructor no longer triggers reconciliation.
        // Callers MUST await initializeAsync() before dispatch/getStatus/
        // collectResult to guarantee durable state has been reconciled.
        // Unawaited reconciliation in the constructor was a race with
        // adapter readiness and could observe stale durable state.
    }

    /**
     * Phase 300 / WP5: explicit asynchronous initialization.
     * Loads authoritative dispatch records from the configured backend and
     * reconciles non-terminal dispatches. Must be awaited by the caller
     * (kernel or test harness) before using the manager.
     */
    public async initializeAsync(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            try {
                if (this.store) {
                    const records = await this.loadPersistedDispatches();
                    await this.reconcilePersistedDispatches(records);
                }
                this.initialized = true;
            } finally {
                this.initPromise = null;
            }
        })();
        return this.initPromise;
    }

    /**
     * Phase 300 / WP5: prefer async backend if available, else sync fallback.
     * ExecutionStore.hasAsyncBackend() gates the path; when absent this is
     * exactly store.listAllRemoteDispatches() (SQLite-only mode preserved).
     */
    private async loadPersistedDispatches(): Promise<RemoteDispatchRecord[]> {
        if (!this.store) return [];
        if (this.store.hasAsyncBackend()) {
            return await this.store.listAllRemoteDispatchesAsync();
        }
        return this.store.listAllRemoteDispatches();
    }

    public async reconcilePersistedDispatches(records: RemoteDispatchRecord[]): Promise<void> {
        for (const record of records) {
            if (this.dispatches.has(record.dispatchId)) continue;

            // Terminal states are already durable; do not overwrite them.
            if (
                record.status === "COMPLETED" ||
                record.status === "FAILED" ||
                record.status === "CANCELLED" ||
                record.status === "BLOCKED"
            ) {
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

            // Phase 300 / WP5: re-read authoritative state through the
            // selected backend (async in shared mode, sync in SQLite-only
            // mode), and write the reconciled status back through the same
            // backend. Terminal states are preserved exactly as before:
            // a terminal dispatch is never overwritten by a stale provider
            // status that resolved while we awaited.
            const fresh = await this.readDispatch(record.dispatchId);
            if (fresh) {
                const isTerminal =
                    fresh.status === "COMPLETED" ||
                    fresh.status === "FAILED" ||
                    fresh.status === "CANCELLED" ||
                    fresh.status === "BLOCKED";
                if (!isTerminal) {
                    await this.writeDispatch({
                        ...fresh,
                        status: finalStatus,
                        updatedAt: Date.now(),
                    });
                }
            }
        }
    }

    /**
     * Phase 300 / WP5: backend-aware dispatch read. Shared mode uses the
     * async siblings (PostgreSQL is authoritative). SQLite-only mode keeps
     * the existing sync path unchanged. The provider-id fallback is preserved
     * for post-restart callers (see existing cancel() contract).
     */
    private async readDispatch(idOrProviderId: string): Promise<RemoteDispatchRecord | undefined> {
        if (!this.store) return undefined;
        if (this.store.hasAsyncBackend()) {
            return (await this.store.getRemoteDispatchAsync(idOrProviderId))
                ?? (await this.store.getRemoteDispatchByExternalProviderIdAsync(idOrProviderId));
        }
        return this.store.getRemoteDispatch(idOrProviderId)
            ?? this.store.listAllRemoteDispatches().find(
                (r) => r.dispatchId === idOrProviderId || r.externalProviderId === idOrProviderId
            );
    }

    /**
     * Phase 300 / WP5: backend-aware dispatch write. Same rationale as
     * readDispatch. Uses the atomic upsert in shared mode.
     */
    private async writeDispatch(record: RemoteDispatchRecord): Promise<void> {
        if (!this.store) return;
        if (this.store.hasAsyncBackend()) {
            await this.store.upsertRemoteDispatchAsync(record);
        } else {
            this.store.upsertRemoteDispatch(record);
        }
    }

    async dispatch(request: ExecutionAdapterRequest, workerId: string, leaseId: string): Promise<{ dispatchId: string }> {
        await this.adapter.connect();
        const result = await this.adapter.dispatch(request, workerId, leaseId);
        this.dispatches.set(result.dispatchId, { adapter: this.adapter, status: "DISPATCHED" });
        return result;
    }

    async cancel(dispatchIdOrProviderId: string): Promise<void> {
        // In-memory lookup first - preserves callers that pass the id
        // returned by dispatch().
        let entry = this.dispatches.get(dispatchIdOrProviderId);
        let durableRecord: RemoteDispatchRecord | undefined;

        // Fall back to durable state. Callers may supply either the
        // durable dispatch id (DispatchService) or the external provider
        // id (post-restart callers). Both must resolve.
        if (!entry && this.store) {
            durableRecord = await this.readDispatch(dispatchIdOrProviderId);
        }

        // The adapter cancel() contract takes the provider identifier,
        // not the durable dispatch identifier.
        const adapterId =
            durableRecord?.externalProviderId ??
            durableRecord?.dispatchId ??
            dispatchIdOrProviderId;

        // Invoke the adapter exactly once. Provider failures propagate.
        await this.adapter.cancel(adapterId);

        // Durable status is the caller's responsibility.
        const key = durableRecord?.dispatchId ?? dispatchIdOrProviderId;
        this.dispatches.set(key, { adapter: this.adapter, status: "CANCELLED" });
        if (entry) entry.status = "CANCELLED";
    }

    async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> {
        const entry = this.dispatches.get(dispatchId);
        if (entry) return entry.adapter.getStatus(dispatchId);
        if (this.store) {
            const record = await this.readDispatch(dispatchId);
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
            const record = await this.readDispatch(dispatchId);
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
