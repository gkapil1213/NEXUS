import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);
  const gate = new SecurityReleaseGate(api);

  console.log("=== Phase 4 Pass 4: Security Release Gate ===\n");

  async function runScan(
    executionId: string,
    projectId: string,
    commit: string,
    artifactDigest?: string
  ) {
    const exec = await api.startExecution(
      projectId,
      executionId,
      commit,
      artifactDigest,
      `rel_${executionId}`
    );
    await runner.runAll(executionId, projectId, commit, artifactDigest, `rel_${executionId}`);
    return exec;
  }

  // Scenario 1: Valid signed artifact, all evidence PASS -> PASS
  console.log("Scenario 1: Valid signed artifact");
  const digest1 = "a".repeat(64);
  const exec1 = await runScan("exec-pass4-1", "proj-pass4", "commit1", digest1);
  const decision1 = await gate.evaluate({
    release_id: "rel-pass4-1",
    execution_id: "exec-pass4-1",
    artifact_id: "artifact-pass4-1",
    artifact_digest: digest1,
    execution: exec1,
  });
  console.log(`Release gate status: ${decision1.status}`);
  if (decision1.status !== "PASS") {
    console.log("FAILED: Expected PASS");
    process.exit(1);
  }

  // Scenario 2: Missing signature (no artifact digest -> signature BLOCKED) -> BLOCKED
  console.log("\nScenario 2: Missing signature");
  const exec2 = await runScan("exec-pass4-2", "proj-pass4", "commit2", undefined);
  const decision2 = await gate.evaluate({
    release_id: "rel-pass4-2",
    execution_id: "exec-pass4-2",
    artifact_id: "artifact-pass4-2",
    artifact_digest: "b".repeat(64),
    execution: exec2,
  });
  console.log(`Release gate status: ${decision2.status}`);
  if (decision2.status !== "BLOCKED") {
    console.log("FAILED: Expected BLOCKED");
    process.exit(1);
  }

  // Scenario 3: Tampered artifact (digest mismatch) -> FAIL/BLOCKED
  console.log("\nScenario 3: Tampered artifact");
  const digest3 = "c".repeat(64);
  const exec3 = await runScan("exec-pass4-3", "proj-pass4", "commit3", digest3);
  const decision3 = await gate.evaluate({
    release_id: "rel-pass4-3",
    execution_id: "exec-pass4-3",
    artifact_id: "artifact-pass4-3",
    artifact_digest: "d".repeat(64), // wrong digest
    execution: exec3,
  });
  console.log(`Release gate status: ${decision3.status}`);
  if (decision3.status === "PASS") {
    console.log("FAILED: Expected BLOCKED/FAIL");
    process.exit(1);
  }

  console.log("\n✅ All release gate scenarios passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});