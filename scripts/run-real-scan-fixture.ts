import { spawnSync } from "node:child_process";
import { RealSecurityScanner } from "../src/core/security-scanners";
import type { ProcessExecutor, ExecutorCapability, ExecResult, AllowlistedCommand } from "../src/core/runtime";

class LocalProcessExecutor implements ProcessExecutor {
  capability(): ExecutorCapability {
    return { available: true, kind: "EXTERNAL_HOST_RUNTIME", reason: null };
  }

  async run(cmd: AllowlistedCommand): Promise<ExecResult> {
    const t0 = Date.now();
    const exe = cmd.tool === "npm" ? "npm.cmd"
      : cmd.tool === "npx" ? "npx.cmd"
      : cmd.tool === "playwright" ? "playwright.cmd"
      : cmd.tool;

    const res = spawnSync(exe, [cmd.operation, ...cmd.args], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: cmd.timeout_ms ?? 180000,
      windowsHide: true,
      shell: false,
    });

    return {
      exit_code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      duration_ms: Date.now() - t0,
      timed_out: false,
    };
  }
}

const scanner = new RealSecurityScanner(new LocalProcessExecutor());
const res = await scanner.runAll("./test-fixture");

const summary = res.results.map((r) => ({
  kind: r.kind,
  status: r.status,
  findings: r.findings.length,
  blocked_reason: r.blocked_reason,
  duration_ms: r.duration_ms,
}));

console.log(JSON.stringify({ capabilities: res.capabilities, summary }, null, 2));
