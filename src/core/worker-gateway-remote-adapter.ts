import { RemoteExecutionAdapter } from "./remote-execution-adapter";
import { ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";
import { WorkerGatewayClient } from "./worker-gateway";
import { randomUUID } from "crypto";

export class WorkerGatewayRemoteExecutionAdapter implements RemoteExecutionAdapter {
  private client: WorkerGatewayClient;

  constructor(workerId: string, credential: string, gatewayUrl: string) {
    this.client = new WorkerGatewayClient(gatewayUrl, workerId, credential);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const ok = await this.client.authenticate(this.client["workerId"], this.client["credential"]);
    if (!ok) throw new Error("worker_gateway_auth_failed");
  }

  async disconnect(): Promise<void> { await this.client.disconnect(); }

  async dispatch(request: ExecutionAdapterRequest, workerId: string, leaseId: string): Promise<{ dispatchId: string }> {
    const dispatchId = randomUUID();
    const job = {
      jobId: request.metadata?.jobId,
      dispatchId,
      leaseId,
      operation: request.operation,
      args: request.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    };
    await this.client.receiveJob(workerId); // we need the gateway to offer job; this client method doesn't support offer. This adapter needs server-side offer.
    // Placeholder: actual implementation would push job to gateway via separate channel.
    throw new Error("Not fully implemented in this checkpoint: use WorkerGateway.offerJob from control plane");
  }

  async cancel(dispatchId: string): Promise<void> { throw new Error("cancel_not_implemented"); }
  async getStatus(dispatchId: string): Promise<{ status: string; evidence?: any }> { return { status: "UNKNOWN" }; }
  async collectResult(dispatchId: string): Promise<ExecutionAdapterResult> {
    return { success: false, stderr: "not_implemented", evidence: { error: "not_implemented" } };
  }
  async *streamLogs(dispatchId: string): AsyncIterable<{ sequence: number; type: string; data: string }> {}
}
