import { artifactSigningService } from "../src/core/artifact-signing.ts";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function runCmd(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `exit ${code}`));
    });
  });
}

(async () => {
  const localRepo = "localhost:5000/nexus/nexus-app";
  const originalImage = "nexus-app:version-a";
  const tamperedTag = "localhost:5000/nexus/nexus-app:tampered-content";

  // Resolve original digest and sign it
  console.log("Resolving original image digest...");
  const origDigestOut = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", originalImage]);
  const origDigestRef = `${localRepo}@${origDigestOut.split("@")[1]}`;
  console.log(`Original digest: ${origDigestRef}`);

  console.log("Signing original image...");
  await artifactSigningService.sign(origDigestRef);

  // Create a genuinely different image with a changed file
  const tmpDir = path.join(process.cwd(), "tamper-fixture");
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "Dockerfile"),
    `FROM nginxinc/nginx-unprivileged:1.27-alpine\nCOPY index.html /usr/share/nginx/html/index.html\nEXPOSE 8080\n`
  );
  await fs.writeFile(path.join(tmpDir, "index.html"), "<html><body>TAMPERED</body></html>");

  console.log("Building tampered image...");
  await runCmd("docker", ["build", "-t", tamperedTag, tmpDir]);

  console.log("Pushing tampered image to registry...");
  await runCmd("docker", ["push", tamperedTag]);

  const tamperedDigestOut = await runCmd("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", tamperedTag]);
  const tamperedDigestRef = `${localRepo}@${tamperedDigestOut.split("@")[1]}`;
  console.log(`Tampered digest: ${tamperedDigestRef}`);

  // Try to verify original signature against tampered digest
  console.log("Verifying original signature against tampered digest...");
  const verifyResult = await artifactSigningService.verify(tamperedDigestRef);

  console.log("Tamper verification result:", verifyResult);
  if (verifyResult.status === "VERIFIED") {
    console.error("Tamper test FAILED: signature verified against tampered image");
    process.exit(1);
  } else {
    console.log("Tamper test PASSED: signature verification correctly failed");
    process.exit(0);
  }
})();