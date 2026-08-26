import { rollbackService } from "../src/core/rollback-service.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

(async () => {
  const containerName = "rollback-safety-test";
  const port = 18082;

  // Reset state to simulate no previous deployments
  await rollbackService.resetForTest();
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});

  const result = await rollbackService.rollback("staging", containerName, port);
  console.log("Rollback result:", JSON.stringify(result, null, 2));

  if (result.status === "BLOCKED") {
    console.log("Negative test passed: rollback blocked with no previous version");
    process.exit(0);
  } else {
    console.error("Negative test failed: expected BLOCKED but got", result.status);
    process.exit(1);
  }
})();