
import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

console.log("Script started");

const nodeHostBridge: HostBridge = {
  platform() {
    console.log("platform called");
    return process.platform;
  },
  async exec(command: string, args: string[], opts: { timeout_ms?: number; cwd?: string }) {
    console.log(`exec called: ${command} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: opts.timeout_ms ?? 120_000,
        cwd: opts.cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      console.log(`exec succeeded: exit_code=0`);
      return { exit_code: 0, stdout, stderr };
    } catch (err: any) {
      console.log(`exec failed: ${err.message}`);
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
  console.log("Scanner created, running runAll...");

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Scan timed out after 60 seconds")), 60000);
  });

  try {
    const result: any = await Promise.race([
      scanner.runAll("."),
      timeoutPromise,
    ]);
    console.log("runAll completed");

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
  } catch (err) {
    console.error("Scan error:", err);
    process.exit(1);
  }
})();