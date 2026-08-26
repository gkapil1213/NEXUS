import { rollbackService } from "../src/core/rollback-service.ts";
import { promises as fs } from "node:fs";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

(async () => {
  const port = 18081;
  const containerName = "rollback-e2e-test";
  const fixtureDir = "rollback-fixture-b";

  // Clean previous state and container
  await rollbackService.resetForTest();
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});

  const commitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const commitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  try {
    // Build image A (current source)
    console.log("Building version A...");
    await rollbackService.dockerBuild("nexus-app:version-a", ".");

    // Build image B with nginx listening on 9090 while container exposes 8080
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(`${fixtureDir}/Dockerfile`, `
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx-broken.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
`);
    await fs.writeFile(`${fixtureDir}/nginx-broken.conf`, `
server {
  listen 9090;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files $uri $uri/ =404;
  }
}
`);
    console.log("Building version B...");
    await rollbackService.dockerBuild("nexus-app:version-b", fixtureDir);

    // Register releases
    const releaseA = await rollbackService.registerRelease("A", commitA, "nexus-app:version-a");
    const releaseB = await rollbackService.registerRelease("B", commitB, "nexus-app:version-b");

    // Deploy A
    console.log("Deploying version A...");
    const depA = await rollbackService.deploy(releaseA, "staging", containerName, port);
    console.log("Deployment A status:", depA.status);
    if (depA.status !== "VERIFIED") throw new Error("Version A verification failed");

    // Deploy B (should fail health)
    console.log("Deploying version B...");
    const depB = await rollbackService.deploy(releaseB, "staging", containerName, port);
    console.log("Deployment B status:", depB.status);
    if (depB.status !== "FAILED") throw new Error("Version B should have failed health check");

    // Rollback
    console.log("Triggering automatic rollback...");
    const rollbackResult = await rollbackService.rollback("staging", containerName, port);
    console.log("Rollback result:", JSON.stringify(rollbackResult, null, 2));
    if (rollbackResult.status !== "SUCCESS") throw new Error("Rollback failed");

    console.log("E2E rollback test passed!");
  } catch (err) {
    console.error("E2E rollback test failed:", err);
    process.exitCode = 1;
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
})();