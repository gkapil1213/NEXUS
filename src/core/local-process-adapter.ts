import { spawn } from "child_process";
import { ExecutionAdapter, ExecutionAdapterRequest, ExecutionAdapterResult, ExecutionAdapterContext } from "./execution-adapter";

export interface LocalProcessOperation {
  command: string;
  args?: string[];
  cwd?: string;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export class LocalProcessAdapter implements ExecutionAdapter {
  private operations = new Map<string, LocalProcessOperation>();
  private running = new Map<string, ReturnType<typeof spawn>>();
  private cancelRequested = new Set<string>();

  constructor(operations: Record<string, LocalProcessOperation>) {
    for (const [op, config] of Object.entries(operations)) {
      this.operations.set(op, config);
    }
  }

  getId(): string {
    return "local-process";
  }

  getType(): string {
    return "local";
  }

  getCapabilities(): string[] {
    return Array.from(this.operations.keys());
  }

  validate(request: ExecutionAdapterRequest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!this.operations.has(request.operation)) {
      errors.push(`Operation ${request.operation} is not allowed`);
      return { valid: false, errors };
    }
    const op = this.operations.get(request.operation)!;

    if (request.args && request.args.some((a) => typeof a !== "string")) {
      errors.push("All arguments must be strings");
    }

    if (request.cwd) {
      if (request.cwd.includes("..")) {
        errors.push("Path traversal detected in cwd");
      }
    }

    if (request.env) {
      const allowed = op.envAllowlist || [];
      for (const key of Object.keys(request.env)) {
        if (!allowed.includes(key)) {
          errors.push(`Environment variable ${key} is not allowed`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(request: ExecutionAdapterRequest, context?: ExecutionAdapterContext): Promise<ExecutionAdapterResult> {
    const validation = this.validate(request);
    if (!validation.valid) {
      return { success: false, stderr: validation.errors.join("; ") };
    }

    const op = this.operations.get(request.operation)!;
    const args = [...(op.args || []), ...(request.args || [])];
    const cwd = request.cwd || op.cwd || process.cwd();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    if (op.envAllowlist) {
      const filtered: Record<string, string> = {};
      for (const key of op.envAllowlist) {
        if (env[key] !== undefined) filtered[key] = env[key];
      }
      if (request.env) {
        for (const key of Object.keys(request.env)) {
          if (op.envAllowlist.includes(key)) filtered[key] = request.env[key];
        }
      }
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, filtered);
    }

    const timeoutMs = request.timeoutMs || op.timeoutMs || 30000;
    const maxStdout = op.maxStdoutBytes || 1024 * 1024;
    const maxStderr = op.maxStderrBytes || 1024 * 1024;

    return new Promise<ExecutionAdapterResult>((resolve) => {
      const execId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.cancelRequested.delete(execId);

      const child = spawn(op.command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
      });

      this.running.set(execId, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
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
        clearTimeout(timer);
        this.running.delete(execId);
        resolve({ success: false, stderr: err.message });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.running.delete(execId);
        if (this.cancelRequested.has(execId)) {
          cancelled = true;
        }
        resolve({
          success: !timedOut && !cancelled && code === 0,
          exitCode: code ?? undefined,
          stdout,
          stderr,
          evidence: { timedOut, cancelled, operation: request.operation },
        });
      });
    });
  }

  async cancel(executionId?: string): Promise<void> {
    if (executionId && this.running.has(executionId)) {
      this.cancelRequested.add(executionId);
      this.running.get(executionId)!.kill("SIGTERM");
    } else {
      for (const [id, child] of this.running) {
        this.cancelRequested.add(id);
        child.kill("SIGTERM");
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
