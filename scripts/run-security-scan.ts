import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Minimal Node.js implementation of the HostBridge interface.
// It uses child_process.execFile to actually run commands on the host.
const nodeHostBridge: HostBridge = {
  platform() {
    return process.platform; // "win32", "linux", ...
  },
  async exec(command: string, args: string[], opts: { timeout_ms?: number; cwd?: string }) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: opts.timeout_ms ?? 120_000,
        cwd: opts.cwd,
        maxBuffer: 10 * 1024 * 1024, // 10 MB, enough for JSON reports
      });
      return { exit_code: 0, stdout, stderr };
    } catch (err: any) {
      // execFile rejects on non‑zero exit or other errors.
      // We normalise to the shape expected by the executor.
      return {
        exit_code: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err),
      };
    }
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