import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";
import { WorkerGateway } from "./worker-gateway";

/**
 * Control-plane client for the WorkerGateway.
 *
 * This adapter MUST NOT touch ExecutionStore directly. All dispatch creation
 * and result retrieval flows through the WorkerGateway control-plane API.
 *
 *   Adapter -> WorkerGateway (control plane) -> ExecutionStore (durable)
 *                                        \-> worker protocol -> WorkerAgent -> real process
 */
export class WorkerGatewayRemoteExecutionAdapter implements RemoteExecutionAdapter {
  constructor(private gateway: WorkerGateway) {}

  async connect(): Promise<void> {
    // The gateway is an in-process control-plane object. `connect` asserts we
    // actually have one; it is not a fake no-op.
    if (!this.gateway) throw new Error("gateway_required");
    if (typeof (this.gateway as any).createDispatch !== "function") {
      throw new Error("gateway_missing_control_plane_api");
    }
  }

  async disconnect(): Promise<void> {
    // The gateway owns its own lifecycle; adapter holds no persistent connection.
  }

  async dispatch(
    request: ExecutionAdapterRequest,
    workerId: string,
    leaseId: string
  ): Promise<{ dispatchId: string }> {
    const jobId = request.metadata?.jobId;
    const attemptId = request.metadata?.attemptId;
    const idempotencyKey = request.metadata?.idempotencyKey;
    if (!jobId || !attemptId || !idempotencyKey) {
      throw new Error("dispatch_metadata_required: jobId, attemptId, idempotencyKey");
    }
    const result = await this.gateway.createDispatch({
      jobId,
      attemptId,
      workerId,
      leaseId,
      idempotencyKey,
      request: {
        operation: request.operation,
        args: request.args,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      },
    });
    return { dispatchId: result.dispatchId };
  }

  async getStatus(dispatchId: string): Promise<{ status: string }> {
    const record = await this.gateway.getDispatchStatus(dispatchId);
    if (!record) throw new Error("dispatch_not_found");
    return { status: record.status };
  }

  async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
    return (await this.gateway.collectDispatchResult(dispatchId)) as ExecutionAdapterResult;
  }

  // --- Explicitly unsupported operations ---------------------------------
  // The current worker protocol does not carry these. We return explicit
  // errors instead of fabricating success.

  async cancel(_dispatchId: string): Promise<void> {
    throw new Error("cancellation_not_confirmable: worker protocol has no JOB_CANCEL handler");
  }

  streamLogs(_dispatchId: string): AsyncIterable<{ sequence: number; type: string; data: string }> {
    // Explicit unsupported: the worker protocol currently carries no log frames.
    // Returning a real AsyncIterable that fails on first iteration (rather than
    // fabricating logs) keeps the interface contract truthful.
    return {
      [Symbol.asyncIterator](): AsyncIterator<{ sequence: number; type: string; data: string }> {
        return {
          next(): Promise<IteratorResult<{ sequence: number; type: string; data: string }>> {
            return Promise.reject(
              new Error("streaming_not_supported: worker protocol carries no log frames")
            );
          },
        };
      },
    };
  }
}
