import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

// Ingest deterministic PASS evidence for every category the release gate
// checks. Used by the gate-logic scenarios below so the test exercises the
// gate against controlled inputs; the real scanner path is covered by
// Pass2/Pass3.
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
    artifactDigest: string | undefined,
    releaseId: string
  ) {
    const exec = await api.startExecution(
      projectId,
      executionId,
      commit,
      artifactDigest,
      releaseId
    );
    await ingestCleanEvidence(api, projectId, executionId, commit, artifactDigest, releaseId);
    return exec;
  }

  // Scenario 1: Valid signed artifact, all evidence PASS -> PASS
  console.log("Scenario 1: Valid signed artifact");
  const digest1 = "a".repeat(64);
  const rel1 = "rel-pass4-1";`n  const exec1 = await runScan("exec-pass4-1", "proj-pass4", "commit1", digest1, rel1);
  const decision1 = await gate.evaluate({
    release_id: rel1,
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
  const rel2 = "rel-pass4-2";`n  const exec2 = await runScan("exec-pass4-2", "proj-pass4", "commit2", undefined, rel2);
  const decision2 = await gate.evaluate({
    release_id: rel2,
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
  const rel3 = "rel-pass4-3";`n  const exec3 = await runScan("exec-pass4-3", "proj-pass4", "commit3", digest3, rel3);
  const decision3 = await gate.evaluate({
    release_id: rel3,
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
