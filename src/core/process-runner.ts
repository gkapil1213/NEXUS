import { spawn } from "child_process";

export interface ProcessResult {
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  command: string;
  args: string[];
}

function runWithSpawn(
  commandLiteral: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ProcessResult> {
  const { timeoutMs = 120000, cwd = process.cwd() } = options;
  const start = Date.now();
  return new Promise((resolve) => {
    // The command is hardcoded in each wrapper; this function is private and not exported.
    // We still need to pass a literal to spawn, so we duplicate the logic in each public function.
    // This function is not used directly; instead, use the wrappers below.
    throw new Error("runWithSpawn should not be used directly");
  });
}

export function runNodeProcess(
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ProcessResult> {
  const { timeoutMs = 120000, cwd = process.cwd() } = options;
  const command = process.execPath;
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "ERROR",
        exitCode: 1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - start,
        timedOut: false,
        command,
        args,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: "TIMEOUT",
          exitCode: 124,
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
          timedOut: true,
          command,
          args,
        });
      } else {
        resolve({
          status: code === 0 ? "PASS" : "FAIL",
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut: false,
          command,
          args,
        });
      }
    });
  });
}

export function runTerraformProcess(
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ProcessResult> {
  const { timeoutMs = 120000, cwd = process.cwd() } = options;
  const command = "terraform";
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "ERROR",
        exitCode: 1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - start,
        timedOut: false,
        command,
        args,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: "TIMEOUT",
          exitCode: 124,
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
          timedOut: true,
          command,
          args,
        });
      } else {
        resolve({
          status: code === 0 ? "PASS" : "FAIL",
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut: false,
          command,
          args,
        });
      }
    });
  });
}

export function runAwsProcess(
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ProcessResult> {
  const { timeoutMs = 120000, cwd = process.cwd() } = options;
  const command = "aws";
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "ERROR",
        exitCode: 1,
        stdout,
        stderr: stderr + "\n" + err.message,
        durationMs: Date.now() - start,
        timedOut: false,
        command,
        args,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: "TIMEOUT",
          exitCode: 124,
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
          timedOut: true,
          command,
          args,
        });
      } else {
        resolve({
          status: code === 0 ? "PASS" : "FAIL",
          exitCode: code ?? 1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut: false,
          command,
          args,
        });
      }
    });
  });
}