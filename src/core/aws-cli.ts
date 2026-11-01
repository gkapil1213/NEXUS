// AWS CLI invoker for startup-time secret retrieval.
// Successful stdout is retained for SecretString parsing.
// stderr and process error text are deliberately never exposed.

import { spawn } from "node:child_process";

export type AwsCliFailure =
  | "spawn_error"
  | "timeout"
  | "output_limit_exceeded"
  | "nonzero_exit";

export interface AwsCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: AwsCliFailure;
}

export type RunAwsFn = (
  args: string[],
  timeoutMs?: number,
) => Promise<AwsCliResult>;

const MAX_STDOUT_BYTES = 256 * 1024;

export const runAws: RunAwsFn = (args, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: AwsCliResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stderr: "" });
    };

    let child: ReturnType<typeof spawn>;

    try {
      child = spawn("aws", args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish({
        exitCode: 127,
        stdout: "",
        stderr: "",
        failure: "spawn_error",
      });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: 124,
        stdout: "",
        stderr: "",
        failure: "timeout",
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;

      const data = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);
      stdoutBytes += data.length;

      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish({
          exitCode: 125,
          stdout: "",
          stderr: "",
          failure: "output_limit_exceeded",
        });
        return;
      }

      stdout += data.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: 127,
        stdout: "",
        stderr: "",
        failure: error.code === "ENOENT" ? "spawn_error" : "spawn_error",
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        finish({
          exitCode,
          stdout: "",
          stderr: "",
          failure: "nonzero_exit",
        });
        return;
      }
      finish({
        exitCode: 0,
        stdout: settled ? "" : stdout,
        stderr: "",
      });
    });
  });
