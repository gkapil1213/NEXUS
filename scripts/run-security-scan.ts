import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

function runCommand(
  command: string,
  args: string[],
  opts: { timeout_ms?: number; cwd?: string },
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isCmd = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".ps1");
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: isCmd ? true : false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = opts.timeout_ms ?? 180_000;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ exit_code: 124, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeout);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exit_code: 1, stdout, stderr: String(err) });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exit_code: code ?? 1, stdout, stderr });
      }
    });
  });
}

const nodeHostBridge: HostBridge = {
  platform() {
    return process.platform;
  },
  async exec(command: string, args: string[], opts: { timeout_ms?: number; cwd?: string }) {
    return runCommand(command, args, opts);
  },
};

(async () => {
  const exec = new HostProcessExecutor(nodeHostBridge);
  const scanner = new RealSecurityScanner(exec);
  const result = await scanner.runAll(".");

  console.log("Security Scan Results");
  console.log("=====================");
  for (const r of result.results) {
    console.log(
      `${r.kind}: ${r.status} (${r.findings.length} findings)` +
        (r.blocked_reason ? ` — ${r.blocked_reason}` : "")
    );
    if (r.findings.length > 0) {
      for (const f of r.findings) {
        console.log(`  • [${f.severity}] ${f.title} (${f.file ?? "n/a"}:${f.line ?? "?"})`);
      }
    }
  }
})();