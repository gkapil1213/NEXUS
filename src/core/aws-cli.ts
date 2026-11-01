// Shared AWS CLI invoker.
//
// Extracted from AWSProvider so that the envelope HMAC key provider can use
// the same spawn/timeout/error semantics without inheriting CloudProvider.
// AWSProvider's inline runAws should be replaced with a call to this module
// in a follow-up cleanup; both use identical logic.

import { spawn } from "node:child_process";

export interface AwsCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunAwsFn = (
  args: string[],
  timeoutMs?: number,
) => Promise<AwsCliResult>;

export const runAws: RunAwsFn = (args, timeoutMs = 30_000) => {
  return new Promise((resolve) => {
    const child = spawn("aws", args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (d: any) => (stdout += d.toString()));
    child.stderr.on("data", (d: any) => (stderr += d.toString()));
    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: String(err) });
    });
    child.on("close", (code: number) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
};