import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { ProductionReleaseDecisionService, ProductionApproval } from "../src/core/production-release-decision";

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);
  const gate = new SecurityReleaseGate(api);
  const decisionService = new ProductionReleaseDecisionService(api, gate);

  // Helper to run a full scan and return execution object
  async function runScan(executionId: string, projectId: string, commit: string, artifactDigest?: string) {
    const exec = await api.startExecution(projectId, executionId, commit, artifactDigest, `rel_${executionId}`);
    await runner.runAll(executionId, projectId, commit, artifactDigest, `rel_${executionId}`);
    return exec;
  }

  console.log("=== Phase 4 Pass 5: Production Release Decision ===\n");

  // Scenario 1: Valid signed artifact, approval granted -> ALLOW
  console.log("Scenario 1: Valid signed artifact + approval");
  const digest1 = "a".repeat(64);
  const exec1 = await runScan("exec-p5-1", "proj-p5", "commit1", digest1);
  const approval1: ProductionApproval = {
    releaseId: "rel-p5-1",
    artifactId: "artifact-p5-1",
    artifactDigest: digest1,
    environment: "production",
    approver: "owner",
    approvedAt: new Date().toISOString(),
    status: "APPROVED",
  };
  const decision1 = await decisionService.decide({
    releaseId: "rel-p5-1",
    executionId: "exec-p5-1",
    artifactId: "artifact-p5-1",
    artifactDigest: digest1,
    approval: approval1,
    execution: exec1,
  });
  console.log(`Decision: ${decision1.status}`);
  if (decision1.status !== "ALLOW") {
    console.log("FAILED: Expected ALLOW");
    process.exit(1);
  }

  // Scenario 2: Unsigned artifact -> BLOCKED
  console.log("\nScenario 2: Unsigned artifact (no signature)");
  const exec2 = await runScan("exec-p5-2", "proj-p5", "commit2", undefined);
  const decision2 = await decisionService.decide({
    releaseId: "rel-p5-2",
    executionId: "exec-p5-2",
    artifactId: "artifact-p5-2",
    artifactDigest: "b".repeat(64),
    approval: approval1, // wrong approval, also should block
    execution: exec2,
  });
  console.log(`Decision: ${decision2.status}`);
  if (decision2.status === "ALLOW") {
    console.log("FAILED: Expected BLOCKED/FAIL");
    process.exit(1);
  }

  // Scenario 3: Tampered artifact -> FAIL/BLOCKED
  console.log("\nScenario 3: Tampered artifact");
  const digest3 = "c".repeat(64);
  const exec3 = await runScan("exec-p5-3", "proj-p5", "commit3", digest3);
  const decision3 = await decisionService.decide({
    releaseId: "rel-p5-3",
    executionId: "exec-p5-3",
    artifactId: "artifact-p5-3",
    artifactDigest: "d".repeat(64), // wrong digest
    approval: approval1,
    execution: exec3,
  });
  console.log(`Decision: ${decision3.status}`);
  if (decision3.status === "ALLOW") {
    console.log("FAILED: Expected BLOCKED/FAIL");
    process.exit(1);
  }

  // Scenario 4: Missing approval -> BLOCKED
  console.log("\nScenario 4: Valid artifact but missing approval");
  const digest4 = "e".repeat(64);
  const exec4 = await runScan("exec-p5-4", "proj-p5", "commit4", digest4);
  const decision4 = await decisionService.decide({
    releaseId: "rel-p5-4",
    executionId: "exec-p5-4",
    artifactId: "artifact-p5-4",
    artifactDigest: digest4,
    // no approval
    execution: exec4,
  });
  console.log(`Decision: ${decision4.status}`);
  if (decision4.status !== "BLOCKED") {
    console.log("FAILED: Expected BLOCKED");
    process.exit(1);
  }

  console.log("\n✅ All critical Pass 5 scenarios passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});