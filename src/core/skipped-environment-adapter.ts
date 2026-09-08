import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export class SkippedEnvironmentRemoteAdapter implements RemoteExecutionAdapter {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async dispatch(_request: ExecutionAdapterRequest, _workerId: string, _leaseId: string): Promise<{ dispatchId: string }> {
    return { dispatchId: "skipped-env" };
  }
  async cancel(_dispatchId: string): Promise<void> {}
  async getStatus(_dispatchId: string): Promise<{ status: string; evidence?: any }> {
    return { status: "SKIPPED_ENVIRONMENT" };
  }
  async collectResult(_dispatchId: string): Promise<ExecutionAdapterResult> {
    return { success: false, evidence: { status: "SKIPPED_ENVIRONMENT" }, stderr: "Remote execution unavailable" };
  }
  async *streamLogs(_dispatchId: string): AsyncIterable<{ sequence: number; type: string; data: string }> {
    // no logs
  }
}


