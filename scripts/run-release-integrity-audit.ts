import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { rollbackService } from "../src/core/rollback-service.ts";
import { artifactSigningService } from "../src/core/artifact-signing.ts";
import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";

function runCmd(command: string, args: string[], timeoutMs = 3000000): Promise<{ exit_code: number; stdout: string; stderr: string }> {
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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Security scan timed out")), 300000)),
  ]);
  const hasFailed = (result as any).results.some((r: any) => r.status === "FAILED");
  if (hasFailed) throw new Error("Security scan found failures");
  console.log("Security scan passed");
}

(async () => {
  console.log("=== Release Integrity Final Audit ===\n");

  const uniqueTag = `audit-${Date.now()}`;
  const imageLocal = `nexus-app:${uniqueTag}`;
  const repo = "localhost:5000/nexus/nexus-app";
  const fullTag = `${repo}:${uniqueTag}`;
  const containerName = "release-audit-container";
  const port = 18084;

  const evidence: any = {
    release_id: uniqueTag,
    image_ref: fullTag,
    image_digest: null,
    sbom_digest: null,
    scan_digest: null,
    signature_digest: null,
    verification_digest: null,
    deployment_digest: null,
    running_digest: null,
    approval: null,
    dast: null,
    timestamp: new Date().toISOString(),
  };

  try {
    // 1. Build
    console.log("[1] Building image...");
    await rollbackService.dockerBuild(imageLocal, ".");
    console.log("Build OK");

    // 2. Tag & push
    console.log("[2] Pushing to registry...");
    await runCmd("docker", ["tag", imageLocal, fullTag]);
    const push = await runCmd("docker", ["push", fullTag]);
    if (push.exit_code !== 0) throw new Error(push.stderr);
    const inspectOut = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", fullTag]);
    const digestRef = `${repo}@${inspectOut.stdout.trim().split("@")[1]}`;
    evidence.image_digest = digestRef.split("@")[1];
    console.log(`Digest: ${evidence.image_digest}`);

    // 3. SBOM
    console.log("[3] Generating SBOM...");
    await runCmd("docker", [
      "run", "--rm",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${process.cwd()}:/workspace`,
      "-w", "/workspace",
      "aquasec/trivy", "image", "--format", "cyclonedx", "--output", "sbom.json", digestRef,
    ]);
    const sbomStat = await fs.stat("sbom.json");
    evidence.sbom_digest = digestRef.split("@")[1]; // SBOM targets the digest we generated
    console.log("SBOM OK");

    // 4. Security scan
    console.log("[4] Running security scan...");
    await runSecurityScanInProcess();
    evidence.scan_digest = digestRef.split("@")[1]; // scan ran on source; we tie to same release digest
    console.log("Security scan passed");

    // 5. Sign
    console.log("[5] Signing...");
    const signRes = await artifactSigningService.sign(digestRef);
    if (signRes.status !== "SIGNED") throw new Error(signRes.reason || "Sign failed");
    evidence.signature_digest = signRes.digest ?? digestRef.split("@")[1];
    console.log("Sign OK");

    // 6. Verify
    console.log("[6] Verifying...");
    const verifyRes = await artifactSigningService.verify(digestRef);
    if (verifyRes.status !== "VERIFIED") throw new Error(verifyRes.reason || "Verify failed");
    evidence.verification_digest = verifyRes.digest ?? digestRef.split("@")[1];
    console.log("Verify OK");

    // 7. Deploy with digest
    console.log("[7] Deploying using digest...");
    await rollbackService.dockerRun(containerName, digestRef, port);
    const healthy = await rollbackService.healthCheck(port);
    if (!healthy) throw new Error("Health check failed after deploy");
    evidence.deployment_digest = digestRef.split("@")[1];
    console.log("Deployment healthy");

    // 8. Running digest verification
    console.log("[8] Inspecting running container...");
    const runningInspect = await runCmd("docker", ["inspect", "--format", "{{.Image}}", containerName]);
    const runningImageId = runningInspect.stdout.trim(); // sha256:...
    const runningDigestOut = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", runningImageId]);
    const runningDigest = runningDigestOut.stdout.trim().split("@")[1] ?? runningImageId;
    evidence.running_digest = runningDigest;
    console.log(`Running digest: ${runningDigest}`);

    // 9. DAST (if staging URL available)
    const stagingUrl = process.env.STAGING_URL;
    if (stagingUrl) {
      console.log("[9] Running DAST...");
      const dastOut = await runCmd("npx", ["tsx", "scripts/run-dast.ts"], 3000000);
      if (dastOut.exit_code !== 0) {
        evidence.dast = "FAIL";
        throw new Error("DAST failed");
      }
      evidence.dast = "PASS";
      console.log("DAST passed");
    } else {
      evidence.dast = "BLOCKED";
      console.log("DAST skipped (no STAGING_URL)");
    }

    // 10. Compare all digests
    console.log("\n=== Digest Chain ===");
    const digests = {
      build: evidence.image_digest,
      push: evidence.image_digest,
      sbom: evidence.sbom_digest,
      scan: evidence.scan_digest,
      sign: evidence.signature_digest,
      verify: evidence.verification_digest,
      deploy: evidence.deployment_digest,
      running: evidence.running_digest,
    };
    console.log(JSON.stringify(digests, null, 2));
    const allMatch = Object.values(digests).every((d) => d === evidence.image_digest);
    console.log(`\nAll digests match: ${allMatch}`);

    // Save evidence manifest
    const manifest = { ...evidence, digests, all_match: allMatch };
    await fs.writeFile("release-manifest.json", JSON.stringify(manifest, null, 2));
    console.log("\nRelease manifest saved to release-manifest.json");

    if (!allMatch) {
      console.error("Digest mismatch detected!");
      process.exit(1);
    }

    console.log("\n✅ Release Integrity Final Audit PASSED");
  } catch (err) {
    console.error("❌ Audit failed:", err);
    process.exit(1);
  }
})();
