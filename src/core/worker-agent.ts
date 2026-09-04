import { WorkerConfig } from "./worker-config";
import { WorkerSecurity } from "./worker-security";
import { WorkerTransport } from "./worker-transport";
import { WorkerSandbox } from "./worker-sandbox";
import { sha256Hex, computeResultDigest } from "./integrity";

export interface WorkerJobRequest {
  jobId: string;
  dispatchId: string;
  leaseId: string;
  operation: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface WorkerJobResult {
  jobId: string;
  dispatchId: string;
  leaseId: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  evidence?: Record<string, any>;
  stdoutSha256?: string;
  stderrSha256?: string;
  resultSha256?: string;
}

export class WorkerAgent {
  private running = false;
  private currentJobId?: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private cancellationRequested = new Set<string>();

  constructor(
    private config: WorkerConfig,
    private security: WorkerSecurity,
    private transport: WorkerTransport,
    private sandbox?: WorkerSandbox
  ) {}

  async start(): Promise<void> {
    await this.transport.connect();
    const authenticated = await this.transport.authenticate(this.config.workerId, this.config.credentialRef);
    if (!authenticated) {
      await this.transport.disconnect();
      throw new Error("Worker authentication failed");
    }
    this.running = true;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    const interval = this.config.heartbeatIntervalMs || 30000;
    this.heartbeatTimer = setInterval(() => {
      this.transport.heartbeat(this.config.workerId, this.currentJobId).catch(() => {});
    }, interval);
  }

  async processOnce(): Promise<WorkerJobResult | null> {
    if (!this.running) return null;
    const job = await this.transport.receiveJob(this.config.workerId);
    if (!job) return null;

    this.currentJobId = job.jobId;
    await this.transport.heartbeat(this.config.workerId, job.jobId);

    const validation = this.security.validateRequest({
      operation: job.operation,
      executable: job.executable,
      args: job.args,
      cwd: job.cwd,
    });
    if (!validation.valid) {
      const result: WorkerJobResult = {
        jobId: job.jobId,
        dispatchId: job.dispatchId,
        leaseId: job.leaseId,
        success: false,
        stderr: validation.errors.join("; "),
        evidence: { validation_failed: true },
      };
      await this.transport.reportResult(this.config.workerId, result);
      this.currentJobId = undefined;
      return result;
    }

    let result: WorkerJobResult;
    if (this.sandbox) {
      const sandboxResult = await this.sandbox.execute({
        executable: job.executable || "node",
        args: job.args || [],
        cwd: job.cwd || this.config.executionRoot || process.cwd(),
        envAllowlist: this.config.envAllowlist,
        timeoutMs: job.timeoutMs || this.config.executionTimeoutMs || 30000,
      });
      const stdoutSha256 = sha256Hex(sandboxResult.stdout);
      const stderrSha256 = sha256Hex(sandboxResult.stderr);
      result = {
        jobId: job.jobId,
        dispatchId: job.dispatchId,
        leaseId: job.leaseId,
        success: sandboxResult.success,
        stdout: sandboxResult.stdout,
        stderr: sandboxResult.stderr,
        exitCode: sandboxResult.exitCode,
        evidence: {
          timedOut: sandboxResult.timedOut,
          cancelled: sandboxResult.cancelled,
          durationMs: sandboxResult.durationMs,
        },
        stdoutSha256,
        stderrSha256,
      };
      result.resultSha256 = computeResultDigest(result as any);
    } else {
      result = {
        jobId: job.jobId,
        dispatchId: job.dispatchId,
        leaseId: job.leaseId,
        success: true,
        stdout: "Simulated execution success",
        evidence: { worker: this.config.workerId },
      };
    }

    await this.transport.reportResult(this.config.workerId, result);
    this.currentJobId = undefined;
    return result;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.transport.disconnect();
  }

  requestCancellation(jobId: string): void {
    this.cancellationRequested.add(jobId);
  }
}
