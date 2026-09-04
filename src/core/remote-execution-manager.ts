import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export class RemoteExecutionManager {
  private dispatches = new Map<string, { adapter: RemoteExecutionAdapter; status: string }>();

  constructor(private adapter: RemoteExecutionAdapter) {}

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
    if (!entry) throw new Error(`Dispatch ${dispatchId} not found`);
    return entry.adapter.getStatus(dispatchId);
  }

  async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
    const entry = this.dispatches.get(dispatchId);
    if (!entry) throw new Error(`Dispatch ${dispatchId} not found`);
    return entry.adapter.collectResult(dispatchId);
  }

  streamLogs(dispatchId: string) {
    const entry = this.dispatches.get(dispatchId);
    if (!entry) throw new Error(`Dispatch ${dispatchId} not found`);
    return entry.adapter.streamLogs(dispatchId);
  }
}
