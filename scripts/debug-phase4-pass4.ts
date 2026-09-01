import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);
  const gate = new SecurityReleaseGate(api);

  const executionId = "debug-pass4-real";
  const projectId = "proj-debug";
  const commit = "commit-debug";
  const digest = "a".repeat(64);
  const releaseId = "rel-debug-pass4-real";

  await api.startExecution(
    projectId,
    executionId,
    commit,
    digest,
    releaseId
  );

  await runner.runAll(
    executionId,
    projectId,
    commit,
    digest,
    releaseId
  );

  const execution = await api.getExecution(executionId);
  const evidence = await api.getEvidence(executionId);
  const findings = await api.getFindings(executionId);
  const risk = await api.assessRisk(executionId);

  const decision = await gate.evaluate({
    release_id: releaseId,
    execution_id: executionId,
    artifact_id: "artifact-debug-pass4-real",
    artifact_digest: digest,
    execution
  });

  console.log("\n=== EXECUTION ===");
  console.log(JSON.stringify(execution, null, 2));

  console.log("\n=== EVIDENCE ===");
  console.log(JSON.stringify(evidence, null, 2));

  console.log("\n=== FINDINGS ===");
  console.log(JSON.stringify(findings, null, 2));

  console.log("\n=== RISK ===");
  console.log(JSON.stringify(risk, null, 2));

  console.log("\n=== RELEASE GATE DECISION ===");
  console.log(JSON.stringify(decision, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
