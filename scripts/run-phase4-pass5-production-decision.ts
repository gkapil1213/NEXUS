import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { ProductionReleaseDecisionService, ProductionApproval } from "../src/core/production-release-decision";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


// Ingest deterministic PASS evidence for every category the release gate
// checks. The gate-logic scenarios use this so the test exercises the gate
// against controlled inputs; the real scanner path is covered by Pass2/Pass3.
async function ingestCleanEvidence(
  api: SecurityApi,
  projectId: string,
  executionId: string,
  commit: string,
  artifactDigest: string | undefined,
  releaseId: string,
): Promise<void> {
  const categories: Array<[string, string]> = [
    ["SAST", "semgrep"],
    ["SCA", "npm-audit"],
    ["SECRET", "gitleaks"],
    ["CONTAINER", "trivy"],
    ["SBOM", "trivy-sbom"],
    ["IAC", "trivy-config"],
    ["DAST", "dast"],
    ["SUPPLY_CHAIN", "supply-chain"],
    ["SIGNATURE", "signature"],
  ];
  for (const [category, scanner] of categories) {
    const now = new Date().toISOString();
    await api.ingestEvidence({
      project_id: projectId,
      execution_id: executionId,
      release_id: releaseId,
      commit_sha: commit,
      artifact_digest: artifactDigest,
      environment: "local",
      scanner,
      category: category as any,
      status: "PASS",
      started_at: now,
      completed_at: now,
      duration_ms: 1,
    } as any);
  }
}

// Isolate this script from production. Direct `npx tsx` invocation
// otherwise resolves openEngine() to nexus.sqlite and writes test
// executions/evidence/findings/decisions into the operator database.
const PASS_DB_DIR = mkdtempSync(join(tmpdir(), "nexus-phase4-"));
const PASS_DB_PATH = resolve(PASS_DB_DIR, "phase4.sqlite");
const PRODUCTION_DB_PATH = resolve("nexus.sqlite");
if (PASS_DB_PATH.toLowerCase() === PRODUCTION_DB_PATH.toLowerCase()) {
  throw new Error("Refusing to run phase4 pass scripts against the production database");
}
process.env.NEXUS_DB_PATH = PASS_DB_PATH;
process.env.NEXUS_PERSISTENCE_ENGINE = "sqlite";
console.log(`Phase4 test database: ${PASS_DB_PATH}`);

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);
  const gate = new SecurityReleaseGate(api);
  const decisionService = new ProductionReleaseDecisionService(api, gate);

  // Helper to run a full scan and return execution object.
  // Ingests PASS evidence with the SAME releaseId the gate is called with,
  // so the assurance release-mismatch rule does not fire on these scenarios.
  async function runScan(executionId: string, projectId: string, commit: string, artifactDigest: string | undefined, releaseId: string) {
    const exec = await api.startExecution(projectId, executionId, commit, artifactDigest, releaseId);
    await ingestCleanEvidence(api, projectId, executionId, commit, artifactDigest, releaseId);
    return exec;
  }

  console.log("=== Phase 4 Pass 5: Production Release Decision ===\n");

  // Scenario 1: Valid signed artifact, approval granted -> ALLOW
  console.log("Scenario 1: Valid signed artifact + approval");
  const digest1 = "a".repeat(64);
  const rel1 = "rel-p5-1";
  const exec1 = await runScan("exec-p5-1", "proj-p5", "commit1", digest1, rel1);
  const approval1: ProductionApproval = {
    releaseId: rel1,
    artifactId: "artifact-p5-1",
    artifactDigest: digest1,
    environment: "production",
    approver: "owner",
    approvedAt: new Date().toISOString(),
    status: "APPROVED",
  };
  const decision1 = await decisionService.decide({
    releaseId: rel1,
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
  const rel2 = "rel-p5-2";
  const exec2 = await runScan("exec-p5-2", "proj-p5", "commit2", undefined, rel2);
  const decision2 = await decisionService.decide({
    releaseId: rel2,
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
  const rel3 = "rel-p5-3";
  const exec3 = await runScan("exec-p5-3", "proj-p5", "commit3", digest3, rel3);
  const decision3 = await decisionService.decide({
    releaseId: rel3,
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
  const rel4 = "rel-p5-4";
  const exec4 = await runScan("exec-p5-4", "proj-p5", "commit4", digest4, rel4);
  const decision4 = await decisionService.decide({
    releaseId: rel4,
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
