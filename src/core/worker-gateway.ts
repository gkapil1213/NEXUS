import { createServer, IncomingMessage, ServerResponse } from "http";
import { WorkerTransport } from "./worker-transport";
import { WorkerSessionStore } from "./worker-session-store";
import { RemoteWorkerStore } from "./remote-worker-store";
import { ExecutionStore } from "./execution-store";
import { WorkerAuthentication } from "./worker-authentication";
import { WorkerTransportSecurity } from "./worker-transport-security";
import { WorkerTransportMessage, WorkerTransportMessageType } from "./worker-transport-messages";
import { WorkerSession } from "./worker-session";
import { RemoteWorker } from "./remote-worker-models";
import { RemoteDispatchRecord, RemoteExecutionResult } from "./execution-models";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const SUPPORTED_PROTOCOL_VERSION = "1.0";

export class WorkerGateway {
  private server: ReturnType<typeof createServer>;
  private security = new WorkerTransportSecurity();
  private listeningPromise?: Promise<void>;

  constructor(
    private port: number,
    private sessionStore: WorkerSessionStore,
    private workerStore: RemoteWorkerStore,
    private auth: WorkerAuthentication,
    private executionStore?: ExecutionStore
  ) {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  start(): Promise<void> {
    if (this.listeningPromise) return this.listeningPromise;
    this.listeningPromise = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.listeningPromise;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return this.send(res, 405, { error: "method_not_allowed" });
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("application/json")) return this.send(res, 415, { error: "unsupported_media_type" });

    let body = "";
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        return this.send(res, 413, { error: "body_too_large" });
      }
      body += chunk;
    }

    let msg: WorkerTransportMessage;
    try {
      msg = JSON.parse(body);
    } catch {
      return this.send(res, 400, { error: "malformed_json" });
    }
    if (!msg?.messageId || !msg?.type) return this.send(res, 400, { error: "missing_message_fields" });

    try {
      const result = await this.handleMessage(msg);
      this.send(res, 200, result);
    } catch (e: any) {
      this.send(res, 400, { error: e.message || "gateway_error" });
    }
  }

  private send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async handleMessage(msg: WorkerTransportMessage): Promise<any> {
    const { type, sessionId, workerId, sequence, messageId, payload, protocolVersion } = msg;
    if (protocolVersion && protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new Error("unsupported_protocol_version");
    }

    // AUTH_REQUEST handled separately
    if (type === "AUTH_REQUEST") {
      const { workerId, credential } = payload;
      const authResult = this.auth.authenticate({ workerId, credential, timestamp: Date.now() });
      if (!authResult.authenticated) return { type: "AUTH_RESPONSE", authenticated: false, reason: authResult.reason };
      const sessionId = authResult.sessionToken!;
      const session: WorkerSession = {
        sessionId,
        workerId,
        status: "ACTIVE",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        createdAt: Date.now(),
        authenticatedAt: Date.now(),
        lastSeenAt: Date.now(),
        lastSequence: 0,
        expiresAt: Date.now() + 60000,
      };
      this.sessionStore.createSession(session);
      return { type: "AUTH_RESPONSE", authenticated: true, sessionId };
    }

    // All other messages require valid session
    if (!sessionId || !workerId) throw new Error("missing_session_or_worker");
    const session = this.sessionStore.getSession(sessionId);
    if (!session || session.workerId !== workerId || session.status !== "ACTIVE") {
      throw new Error("invalid_session");
    }
    if (session.expiresAt < Date.now()) {
      this.sessionStore.markRevoked(sessionId);
      throw new Error("session_expired");
    }

    // Durable sequence validation
    if (sequence === undefined || sequence <= session.lastSequence) {
      throw new Error("invalid_sequence");
    }

    // Validate messageId freshness (in-memory only; durable idempotency handled separately for result)
    const freshness = this.security.validateFreshMessage(messageId, sessionId, sequence);
    if (!freshness.valid) throw new Error(freshness.reason || "invalid_message");

    // Accept and advance durable session sequence
    session.lastSequence = sequence;
    session.lastSeenAt = Date.now();
    this.sessionStore.updateSession(session);
    this.security.acceptMessage(messageId, sessionId, sequence);

    switch (type) {
      case "HEARTBEAT": {
        const worker = this.workerStore.getWorker(workerId);
        if (!worker) throw new Error("worker_not_found");
        worker.lastHeartbeatAt = Date.now();
        worker.status = payload?.currentJobId ? "BUSY" : "ONLINE";
        this.workerStore.updateWorker(worker);
        return { type: "HEARTBEAT_ACK" };
      }
      case "JOB_OFFER": {
        // Durable delivery: use executionStore to find next eligible dispatch
        if (!this.executionStore) throw new Error("durable_store_unavailable");
        const eligible = this.executionStore.listRemoteDispatchesByWorkerStatus(workerId, "DISPATCHED");
        const dispatch = eligible[0];
        if (!dispatch) return { type: "JOB_OFFER", job: null };
        // Atomically mark as DELIVERED
        const updated = { ...dispatch, status: "DELIVERED" as const, updatedAt: Date.now() };
        this.executionStore.upsertRemoteDispatch(updated);
        return {
          type: "JOB_OFFER",
          job: {
            jobId: dispatch.jobId,
            dispatchId: dispatch.dispatchId,
            leaseId: dispatch.leaseId,
            operation: dispatch.request?.operation,
            args: dispatch.request?.args,
            cwd: dispatch.request?.cwd,
            timeoutMs: dispatch.request?.timeoutMs,
          },
        };
      }
      case "JOB_RESULT": {
        const { jobId, result } = payload;
        if (!this.executionStore) throw new Error("durable_store_unavailable");
        const dispatch = this.executionStore.getRemoteDispatch(result.dispatchId);
        if (!dispatch || dispatch.workerId !== workerId || dispatch.jobId !== jobId) {
          throw new Error("dispatch_ownership_violation");
        }
        // Idempotent duplicate detection
        const existing = this.executionStore.getRemoteExecutionResultByDispatchId(result.dispatchId);
        if (existing) {
          if (existing.resultSha256 === result.resultSha256) {
            return { type: "JOB_RESULT_ACK" };
          }
          throw new Error("conflicting_duplicate_result");
        }

        const durableResult: RemoteExecutionResult = {
          resultId: `result_${result.dispatchId}`,
          jobId: result.jobId,
          attemptId: dispatch.attemptId,
          workerId: result.workerId || workerId,
          dispatchId: result.dispatchId,
          leaseId: result.leaseId,
          success: result.success,
          exitCode: result.exitCode,
          stdoutRef: result.stdout,
          stderrRef: result.stderr,
          evidence: result.evidence,
          createdAt: Date.now(),
          stdoutSha256: result.stdoutSha256,
          stderrSha256: result.stderrSha256,
          resultSha256: result.resultSha256,
        };
        const updatedDispatch: RemoteDispatchRecord = {
          ...dispatch,
          result: {
            success: result.success,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            evidence: result.evidence,
          },
          status: result.success ? "COMPLETED" : "FAILED",
          updatedAt: Date.now(),
        };

        // Atomic persist
        this.executionStore.persistRemoteExecutionResultAndDispatch(durableResult, updatedDispatch);
        return { type: "JOB_RESULT_ACK" };
      }
      case "JOB_CANCEL":
        throw new Error("cancellation_not_implemented");
      default:
        throw new Error("unknown_message_type");
    }
  }

  offerJob(workerId: string, job: any): void {
    // Convert a direct job offer into a durable dispatch record
    if (!this.executionStore) return;
    const dispatch: RemoteDispatchRecord = {
      dispatchId: job.dispatchId,
      jobId: job.jobId,
      attemptId: job.attemptId || `attempt_${job.jobId}`,
      workerId,
      leaseId: job.leaseId,
      idempotencyKey: job.idempotencyKey || `idem_${job.jobId}`,
      status: "DISPATCHED",
      request: {
        operation: job.operation,
        args: job.args,
        cwd: job.cwd,
        timeoutMs: job.timeoutMs,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.executionStore.upsertRemoteDispatch(dispatch);
  }

  getResult(jobId: string): any {
    if (!this.executionStore) return undefined;
    const result = this.executionStore.getRemoteExecutionResultByJobId(jobId);
    return result ? { workerId: result.workerId, result } : undefined;
  }
}

export class WorkerGatewayClient implements WorkerTransport {
  private connected = false;
  private sessionId?: string;
  private authToken?: string;
  private sequence = 0;

  constructor(private gatewayUrl: string, private workerId: string, private credential: string) {}

  async connect(): Promise<void> { this.connected = true; }

  private async post(message: any): Promise<any> {
    const res = await fetch(this.gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`gateway_invalid_response: ${res.status}`); }
    if (res.status !== 200) throw new Error(json.error || `gateway_error_${res.status}`);
    return json;
  }

  async authenticate(workerId: string, credential: string): Promise<boolean> {
    if (workerId !== this.workerId || credential !== this.credential) return false;
    const response = await this.post({
      messageId: crypto.randomUUID(),
      type: "AUTH_REQUEST",
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      payload: { workerId, credential },
    });
    if (response.authenticated) {
      this.sessionId = response.sessionId;
      this.authToken = response.sessionId;
      return true;
    }
    return false;
  }

  async heartbeat(workerId: string, currentJobId?: string): Promise<void> {
    if (!this.connected || !this.sessionId) throw new Error("not_authenticated");
    await this.post({
      messageId: crypto.randomUUID(),
      type: "HEARTBEAT",
      sessionId: this.sessionId,
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      sequence: ++this.sequence,
      payload: { currentJobId },
    });
  }

  async receiveJob(workerId: string): Promise<any | null> {
    if (!this.connected || !this.sessionId) throw new Error("not_authenticated");
    const response = await this.post({
      messageId: crypto.randomUUID(),
      type: "JOB_OFFER",
      sessionId: this.sessionId,
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      sequence: ++this.sequence,
    });
    return response.job || null;
  }

  async reportResult(workerId: string, result: any): Promise<void> {
    if (!this.connected || !this.sessionId) throw new Error("not_authenticated");
    await this.post({
      messageId: crypto.randomUUID(),
      type: "JOB_RESULT",
      sessionId: this.sessionId,
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      sequence: ++this.sequence,
      payload: { jobId: result.jobId, result },
    });
  }

  async cancelJob(workerId: string, jobId: string): Promise<void> {
    if (!this.connected || !this.sessionId) throw new Error("not_authenticated");
    await this.post({
      messageId: crypto.randomUUID(),
      type: "JOB_CANCEL",
      sessionId: this.sessionId,
      workerId,
      timestamp: Date.now(),
      protocolVersion: "1.0",
      sequence: ++this.sequence,
      payload: { jobId },
    });
  }

  async disconnect(): Promise<void> { this.connected = false; this.sessionId = undefined; }
}
