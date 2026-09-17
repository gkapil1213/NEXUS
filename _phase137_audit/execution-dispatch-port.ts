import { ExecutionJob, ExecutionAttempt } from "./execution-models";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export interface ExecutionDispatchPort {
    dispatch(job: ExecutionJob, attempt: ExecutionAttempt, leaseId: string, request: ExecutionAdapterRequest): Promise<{ dispatchId: string }>;
    collectResult(dispatchId: string): Promise<ExecutionAdapterResult>;
    cancel(dispatchId: string): Promise<void>;
    getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }>;
}
