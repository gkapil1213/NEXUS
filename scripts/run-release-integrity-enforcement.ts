import { spawn } from "node:child_process";
import { rollbackService } from "../src/core/rollback-service.ts";
import { artifactSigningService } from "../src/core/artifact-signing.ts";
import { RealSecurityScanner } from "../src/core/security-scanners.ts";
import { HostProcessExecutor } from "../src/core/runtime.ts";
import type { HostBridge } from "../src/core/runtime.ts";

// -------------------- command runner --------------------
function runCmd(
  command: string,
  args: string[],
  timeoutMs = 180000,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
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

// -------------------- in-process security scan --------------------
async function runSecurityScanInProcess(): Promise<void> {
  const bridge: HostBridge = {
    platform() {
      return process.platform;
    },
    async exec(command, args, opts) {
      return runCmd(command, args, opts?.timeout_ms ?? 180000);
    },
  };
  const exec = new HostProcessExecutor(bridge);
  const scanner = new RealSecurityScanner(exec);
  const result = await Promise.race([
    scanner.runAll("."),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Security scan timed out after 120s")), 120000)
    ),
  ]);

  const hasFailed = (result as any).results.some((r: any) => r.status === "FAILED");
  if (hasFailed) {
    throw new Error("Security scan found failures");
  }
  console.log("Security scan passed");
}

// -------------------- main flow --------------------
(async () => {
  console.log("Release integrity enforcement starting...");

  const imageTag = "nexus-app:version-a";
  const localTag = "localhost:5000/nexus/nexus-app:version-a";
  const containerName = "release-integrity-test";
  const port = 18083;

  try {
    // 1. Build
    console.log("[1] Building image...");
    await rollbackService.dockerBuild(imageTag, ".");
    console.log("Build OK");

    // 2. Push to local registry
    console.log("[2] Pushing to local registry...");
    await runCmd("docker", ["tag", imageTag, localTag]);
    const push = await runCmd("docker", ["push", localTag]);
    if (push.exit_code !== 0) throw new Error(push.stderr);
    console.log("Push OK");

    // Resolve digest
    const inspect = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", localTag]);
    if (inspect.exit_code !== 0) throw new Error(inspect.stderr);
    const digestRef = "localhost:5000/nexus/nexus-app@" + inspect.stdout.trim().split("@")[1];
    console.log(`Digest: ${digestRef}`);

    // 3. SBOM
    console.log("[3] Generating SBOM...");
    await runCmd("docker", [
      "run", "--rm",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${process.cwd()}:/workspace`,
      "-w", "/workspace",
      "aquasec/trivy", "image", "--format", "cyclonedx", "--output", "sbom.json", imageTag,
    ]);
    console.log("SBOM OK");

    // 4. Security scan (in-process)
    console.log("[4] Running security scan...");
    await runSecurityScanInProcess();

    // 5. Sign
    console.log("[5] Signing...");
    const signRes = await artifactSigningService.sign(digestRef);
    if (signRes.status !== "SIGNED") throw new Error(signRes.reason || "Sign failed");
    console.log("Sign OK");

    // 6. Verify
    console.log("[6] Verifying...");
    const verifyRes = await artifactSigningService.verify(digestRef);
    if (verifyRes.status !== "VERIFIED") throw new Error(verifyRes.reason || "Verify failed");
    console.log("Verify OK");

    // 7. Deploy
    console.log("[7] Deploying...");
    await rollbackService.dockerRun(containerName, digestRef, port);
    const healthy = await rollbackService.healthCheck(port);
    if (!healthy) throw new Error("Health check failed after deploy");
    console.log("Deployment healthy");

    console.log("\n✅ Release integrity enforcement passed.");
  } catch (err) {
    console.error("❌ Release integrity enforcement failed:", err);
    process.exit(1);
  }
})();