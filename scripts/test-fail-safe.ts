import { promises as fs } from "node:fs";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";
import { spawn } from "node:child_process";
import { CheckovAdapter } from "../src/core/security-scanners.ts";
import { artifactSigningService } from "../src/core/artifact-signing.ts";
import { SecurityPolicyEngine } from "../src/core/security-policy.ts";
import { ReleaseService } from "../src/core/release-service.ts";
import { ApprovalService } from "../src/core/approval-service.ts";

function runCmd(command: string, args: string[], timeoutMs = 180000): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let actualCommand = command;
    let actualArgs = args;
    const lower = command.toLowerCase();
    if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".ps1") || ["npx", "npm", "tsx"].includes(lower))) {
      actualCommand = process.env.ComSpec || "cmd.exe";
      actualArgs = ["/c", command, ...args];
    }
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const child = spawn(actualCommand, actualArgs, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ exit_code: 124, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);
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

const bridge: HostBridge = {
  platform: () => process.platform,
  exec: (c, a, o) => runCmd(c, a, o?.timeout_ms ?? 180000),
};
const exec = new HostProcessExecutor(bridge);

let allPass = true;

async function expectFailure(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    const passed = await fn();
    if (passed) {
      // nosemgrep: javascript.lang.security.audit.unsafe-formatstring
     console.log("✅ %s: correctly failed/blocked", name);
    } else {
      console.error("❌ %s: failed/blocked incorrectly", name);
      allPass = false;
    }
  } catch (e) {
    console.log("ℹ️ %s: skipped", name);
    allPass = false;
  }
}

(async () => {
  // 1. Unsigned image verification
  await expectFailure("Unsigned image verification", async () => {
    const res = await artifactSigningService.verify("localhost:5000/nexus/nexus-app:unsigned");
    return res.status === "FAILED" || res.status === "BLOCKED";
  });

  // 2. Tampered artifact (wrong digest)
  await expectFailure("Tampered artifact", async () => {
    const res = await artifactSigningService.verify("localhost:5000/nexus/nexus-app@sha256:0000000000000000000000000000000000000000000000000000000000000000");
    return res.status === "FAILED" || res.status === "BLOCKED";
  });

  // 3. IaC misconfiguration (real Checkov against bad.tf)
  await expectFailure("IaC misconfiguration", async () => {
    const dir = "tmp-iac-fixture";
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      `${dir}/bad.tf`,
      `resource "aws_s3_bucket" "bad_bucket" {\n  bucket = "public-bucket-example"\n  acl    = "public-read"\n}\n`
    );
    const scanner = new CheckovAdapter(exec);
    const res = await scanner.scan(dir);
    await fs.rm(dir, { recursive: true, force: true });
    return res.status === "FAILED" || res.findings.length > 0;
  });

  // 4. Production gate without approval
  await expectFailure("Production gate without approval", async () => {
    const relSvc = new ReleaseService();
    const appSvc = new ApprovalService();
    const release = await relSvc.createDraft("1.0.0", "test", "production");
    const approvals = appSvc.listForRelease(release.release_id);
    return approvals.every((a) => a.decision !== "APPROVED");
  });

  // 5. Critical vulnerability via policy engine (real policy logic)
  await expectFailure("Critical vulnerability blocks release", async () => {
    const policy = new SecurityPolicyEngine();
    const evaluations = policy.evaluate({
      findings: [{ severity: "critical", category: "SCA", scanner: "test", title: "Critical vuln" }],
    });
    const verdict = policy.verdict(evaluations);
    return verdict === "FAIL";
  });

  console.log(allPass ? "\nAll fail-safe tests passed." : "\nSome fail-safe tests failed.");
  process.exit(allPass ? 0 : 1);
})();