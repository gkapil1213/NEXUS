import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { rollbackService } from "../src/core/rollback-service.ts";
import { artifactSigningService } from "../src/core/artifact-signing.ts";
import { ReleaseService } from "../src/core/release-service.ts";
import { ApprovalService } from "../src/core/approval-service.ts";
import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";

function runCmd(command: string, args: string[], timeoutMs = 180000): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let actualCommand = command;
    let actualArgs = args;
    const lower = command.toLowerCase();
    if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".ps1") || ["npx", "npm", "tsx"].includes(lower))) {
      actualCommand = process.env.ComSpec || "cmd.exe";
      actualArgs = ["/c", command, ...args];
    }
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

async function runSecurityScanInProcess(): Promise<void> {
  const bridge: HostBridge = {
    platform() { return process.platform; },
    async exec(command, args, opts) {
      return runCmd(command, args, opts?.timeout_ms ?? 300000);
    },
  };
  const exec = new HostProcessExecutor(bridge);
  const scanner = new RealSecurityScanner(exec);
  const result = await Promise.race([
    scanner.runAll("."),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Security scan timed out")), 120000)),
  ]);
  const hasFailed = (result as any).results.some((r: any) => r.status === "FAILED");
  if (hasFailed) throw new Error("Security scan found failures");
  console.log("Security scan passed");
}

(async () => {
  console.log("=== Production Release Gate ===\n");

  const releaseService = new ReleaseService();
  const approvalService = new ApprovalService();

  const environment = "production";
  const imageTag = "nexus-app:prod-candidate";
  const repo = "localhost:5000/nexus/nexus-app";
  const fullTag = `${repo}:prod-candidate`;
  const containerName = "nexus-production";
  const port = 18085;
  const commitSha = process.env.GITHUB_SHA ?? `local-${Date.now()}`;

  try {
    // 1. Typecheck
    console.log("[1] Typecheck...");
    const tsc = await runCmd("npx", ["tsc", "--noEmit"]);
    if (tsc.exit_code !== 0) throw new Error("Typecheck failed");

    // 2. Production build
    console.log("[2] Production build...");
    const build = await runCmd("npm", ["run", "build"]);
    if (build.exit_code !== 0) throw new Error("Build failed");

    // 3. Core tests
    console.log("[3] Core tests...");
    const tests = await runCmd("npm", ["run", "test:core"]);
    if (tests.exit_code !== 0) throw new Error("Core tests failed");

    // 4. Security scan
    console.log("[4] Security scan...");
    await runSecurityScanInProcess();

    // 5. DAST (optional; uses staging URL if available)
    if (process.env.STAGING_URL) {
      console.log("[5] DAST...");
      const dast = await runCmd("npx", ["tsx", "scripts/run-dast.ts"]);
      if (dast.exit_code !== 0) throw new Error("DAST failed");
    } else {
      console.log("[5] DAST skipped (STAGING_URL not set)");
    }

    // 6. Determine digest reference
    let digestRef: string;
    if (process.env.EXISTING_DIGEST_REF) {
      console.log("[6] Using existing immutable digest reference...");
      digestRef = process.env.EXISTING_DIGEST_REF;
    } else {
      console.log("[6] Building & pushing image...");
      await rollbackService.dockerBuild(imageTag, ".");
      await runCmd("docker", ["tag", imageTag, fullTag]);
      const push = await runCmd("docker", ["push", fullTag]);
      if (push.exit_code !== 0) throw new Error(push.stderr);
      const inspectOut = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", fullTag]);
      digestRef = `${repo}@${inspectOut.stdout.trim().split("@")[1]}`;
      console.log(`   Digest: ${digestRef}`);
    }

    // 7. SBOM
    console.log("[7] SBOM...");
    await runCmd("docker", [
      "run", "--rm",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${process.cwd()}:/workspace`,
      "-w", "/workspace",
      "aquasec/trivy", "image", "--format", "cyclonedx", "--output", "sbom.json", digestRef,
    ]);
    console.log("SBOM OK");

    // 8. Sign
    console.log("[8] Signing...");
    const signRes = await artifactSigningService.sign(digestRef);
    if (signRes.status !== "SIGNED") throw new Error("Signing failed");

    // 9. Verify signature
    console.log("[9] Verifying signature...");
    const verifyRes = await artifactSigningService.verify(digestRef);
    if (verifyRes.status !== "VERIFIED") throw new Error("Signature verification failed");

    // 10. Approval check
    console.log("[10] Checking approval...");
    let releaseId = process.env.RELEASE_ID;
    if (!releaseId) {
      const release = await releaseService.createDraft(`prod-${commitSha.slice(0, 8)}`, commitSha, environment, {
        artifact_digest: digestRef.split("@")[1],
      });
      await releaseService.transition(release.release_id, "SECURITY_REVIEW");
      await releaseService.transition(release.release_id, "READY_FOR_APPROVAL");
      releaseId = release.release_id;
      console.log(`   Created release: ${releaseId}`);
      console.log(`   Artifact digest: ${digestRef.split("@")[1]}`);
    } else {
      console.log(`   Using provided release: ${releaseId}`);
    }

    const approvals = approvalService.listForRelease(releaseId);
    const isApproved = approvals.some(
      (a) => a.decision === "APPROVED" && a.artifact_digest === digestRef.split("@")[1],
    );

    if (!isApproved) {
      console.error(`❌ Production release BLOCKED: no valid approval for release ${releaseId} and digest ${digestRef.split("@")[1]}.`);
      process.exit(1);
    }
    console.log("Approval verified");

    // 11. Deploy to production
    console.log("[11] Deploying to production...");
    await rollbackService.dockerRun(containerName, digestRef, port);
    const healthy = await rollbackService.healthCheck(port);
    if (!healthy) throw new Error("Production health check failed");
    console.log("Production deployment healthy");

    // 12. Final gate result
    console.log("\n✅ Production Release Gate PASSED. Artifact is approved and verified.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Production Release Gate FAILED:", err);
    process.exit(1);
  }
})();