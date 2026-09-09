import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult, ExecutionAdapter } from "./execution-adapter";
import { randomUUID } from "crypto";

export class LocalProcessRemoteExecutionAdapter implements RemoteExecutionAdapter {
    private results = new Map<string, Promise<ExecutionAdapterResult>>();

    constructor(private executionAdapter: ExecutionAdapter) {}

    async connect(): Promise<void> {}

    async disconnect(): Promise<void> {}

    async dispatch(request: ExecutionAdapterRequest, workerId: string, leaseId: string): Promise<{ dispatchId: string }> {
        const dispatchId = randomUUID();
        this.results.set(dispatchId, this.executionAdapter.execute(request));
        return { dispatchId };
    }

    async cancel(dispatchId: string): Promise<void> {
        throw new Error("Cancellation not supported for local process remote adapter");
    }

    async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> {
        const result = await this.results.get(dispatchId);
        return result ? { status: result.success ? "COMPLETED" : "FAILED", evidence: result.evidence } : { status: "UNKNOWN" };
    }

    async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
        const result = await this.results.get(dispatchId);
        if (!result) throw new Error(`Dispatch ${dispatchId} not found`);
        return result;
    }

    async *streamLogs(dispatchId: string): AsyncIterable<{ sequence: number; type: string; data: string }> {
        // No streaming support
    }
}
