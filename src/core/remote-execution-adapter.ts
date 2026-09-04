import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export interface RemoteExecutionAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  dispatch(request: ExecutionAdapterRequest, workerId: string, leaseId: string): Promise<{ dispatchId: string }>;
  cancel(dispatchId: string): Promise<void>;
  getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }>;
  collectResult(dispatchId: string): Promise<ExecutionAdapterResult>;
  streamLogs(dispatchId: string): AsyncIterable<{ sequence: number; type: string; data: string }>;
}
