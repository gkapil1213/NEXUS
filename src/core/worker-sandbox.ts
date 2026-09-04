import { spawn } from "child_process";

export interface WorkerSandboxConfig {
  executable: string;
  args?: string[];
  cwd: string;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface WorkerSandboxResult {
  success: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export class WorkerSandbox {
  private runningProcesses = new Map<string, ReturnType<typeof spawn>>();
  private cancelledIds = new Set<string>();

  async execute(config: WorkerSandboxConfig): Promise<WorkerSandboxResult> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    if (config.envAllowlist) {
      const filtered: Record<string, string> = {};
      for (const key of config.envAllowlist) {
        if (env[key] !== undefined) filtered[key] = env[key];
      }
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, filtered);
    }

    const timeoutMs = config.timeoutMs || 30000;
    const maxStdout = config.maxStdoutBytes || 1024 * 1024;
    const maxStderr = config.maxStderrBytes || 1024 * 1024;
    const startedAt = Date.now();

    return new Promise<WorkerSandboxResult>((resolve) => {
      const execId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.cancelledIds.delete(execId);

      const child = spawn(config.executable, config.args || [], {
        cwd: config.cwd,
        env,
        shell: false,
        windowsHide: true,
      });

      this.runningProcesses.set(execId, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const finish = (result: WorkerSandboxResult) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          result.startedAt = startedAt;
          result.completedAt = Date.now();
          result.durationMs = result.completedAt - result.startedAt;
          this.runningProcesses.delete(execId);
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000);
      }, timeoutMs);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.length > maxStdout) {
          stdout = stdout.slice(0, maxStdout) + "\n[OUTPUT TRUNCATED]";
          child.kill("SIGKILL");
        }
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
        if (stderr.length > maxStderr) {
          stderr = stderr.slice(0, maxStderr) + "\n[ERROR OUTPUT TRUNCATED]";
          child.kill("SIGKILL");
        }
      });

      child.on("error", (err) => {
        finish({
          success: false,
          stdout,
          stderr: err.message,
          timedOut,
          cancelled,
          startedAt,
          completedAt: Date.now(),
          durationMs: 0,
        });
      });

      child.on("close", (code) => {
        if (this.cancelledIds.has(execId)) cancelled = true;
        finish({
          success: !timedOut && !cancelled && code === 0,
          exitCode: code ?? undefined,
          stdout,
          stderr,
          timedOut,
          cancelled,
          startedAt,
          completedAt: Date.now(),
          durationMs: 0,
        });
      });
    });
  }

  cancelAll(): void {
    for (const [id, child] of this.runningProcesses) {
      this.cancelledIds.add(id);
      child.kill("SIGTERM");
    }
  }

  cancel(executionId?: string): void {
    if (executionId && this.runningProcesses.has(executionId)) {
      this.cancelledIds.add(executionId);
      this.runningProcesses.get(executionId)!.kill("SIGTERM");
    } else {
      this.cancelAll();
    }
  }
}
