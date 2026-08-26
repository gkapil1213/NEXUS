import { SecurityPolicyEngine } from "../src/core/security-policy.ts";
import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { spawn } from "node:child_process";

function runCommand(
  command: string,
  args: string[],
  opts: { timeout_ms?: number; cwd?: string },
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isCmd = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".ps1");
    let child;
    if (isCmd) {
      child = spawn(process.env.ComSpec || "cmd.exe", ["/c", command, ...args], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
      });
    } else {
      child = spawn(command, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
      });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = opts.timeout_ms ?? 120_000;

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

  console.log("Security scan starting...");

  // Wrap with global timeout (2 minutes)
  const result: any = await Promise.race([
    scanner.runAll("."),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Security scan timed out after 120 seconds")), 120000)
    ),
  ]);

  console.log("Security scan completed.");
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

  const allFindings = result.results.flatMap((r: any) =>
    r.findings.map((f: any) => ({
      severity: f.severity,
      category: f.category,
      scanner: f.scanner,
      title: f.title,
    }))
  );
  const policyEngine = new SecurityPolicyEngine();
  const evaluations = policyEngine.evaluate({ findings: allFindings });
  if (evaluations.length > 0) {
    console.log("\nPolicy Evaluations:");
    for (const e of evaluations) {
      console.log(`  • ${e.decision}: ${e.rule_name} — ${e.reason}`);
    }
    const verdict = policyEngine.verdict(evaluations);
    console.log(`Policy verdict: ${verdict}`);
    if (verdict === "FAIL") process.exit(1);
  }

  const hasFailed = result.results.some((r: any) => r.status === "FAILED");
  if (hasFailed) process.exit(1);
})();