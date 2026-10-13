import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import {
  ProductionReleaseDecisionService,
  ProductionApproval,
} from "../src/core/production-release-decision";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import { CosignService } from "../src/core/artifact-signing";
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
  const enforcement = new ProductionReleaseEnforcementService(api, gate, decisionService);

  console.log("=== Phase 4 Pass 6: Production Release Enforcement ===\n");

  async function runScan(
    executionId: string,
    projectId: string,
    commit: string,
    artifactDigest: string | undefined,
    releaseId: string,
    signArtifact = false
  ) {
    const exec = await api.startExecution(
      projectId,
      executionId,
      commit,
      artifactDigest,
      releaseId
    );
    await ingestCleanEvidence(api, projectId, executionId, commit, artifactDigest, releaseId);

    if (signArtifact && artifactDigest) {
      // Sign the artifact so that enforcement can verify it
      const cosign = new CosignService();
      await cosign.sign(`localhost:5000/nexus/nexus-app@sha256:${artifactDigest}`);
    }
    return exec;
  }

  try {
    // Scenario 1: Valid signed artifact + approval
    console.log("Scenario 1: Valid signed artifact + approval");
    const digest1 = "a".repeat(64);
    const rel1 = "rel-p6-1";
    const exec1 = await runScan("exec-p6-1", "proj-p6", "commit1", digest1, rel1, true);

    const approval1: ProductionApproval = {
      releaseId: rel1,
      artifactId: "artifact-p6-1",
      artifactDigest: digest1,
      environment: "production",
      approver: "owner",
      approvedAt: new Date().toISOString(),
      status: "APPROVED",
    };

    const authResult1 = await enforcement.requestRelease({
      releaseId: rel1,
      executionId: "exec-p6-1",
      artifactId: "artifact-p6-1",
      artifactDigest: digest1,
      commitSha: "commit1",
      environment: "production",
      approval: approval1,
      execution: exec1,
    });

    console.log(`Expected: AUTHORIZED\nActual: ${authResult1.status}\n`);
    if (authResult1.status !== "AUTHORIZED" || !authResult1.authorization) {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    // Scenario 2: Unsigned artifact
    console.log("Scenario 2: Unsigned artifact");
    const rel2 = "rel-p6-2";
    const exec2 = await runScan("exec-p6-2", "proj-p6", "commit2", undefined, rel2);

    const approval2: ProductionApproval = {
      ...approval1,
      releaseId: rel2,
      artifactId: "artifact-p6-2",
      artifactDigest: "b".repeat(64),
      environment: "production",
    };

    const authResult2 = await enforcement.requestRelease({
      releaseId: rel2,
      executionId: "exec-p6-2",
      artifactId: "artifact-p6-2",
      artifactDigest: "b".repeat(64),
      commitSha: "commit2",
      environment: "production",
      approval: approval2,
      execution: exec2,
    });

    console.log(`Expected: BLOCKED\nActual: ${authResult2.status}\n`);
    if (authResult2.status !== "BLOCKED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    // Scenario 3: Same-attempt authorization retry. Phase 138 consumes the
    // authorization on the executeRelease (provider-invocation) boundary, not
    // on authorizeExecution, so a same-attempt retry is allowed before
    // consumption. Replay detection against a different attempt requires a
    // durable store + real ExecutionAttempt; it is covered by
    // test-phase138-attempt-authority.ts (T-A4) and
    // test-phase140-attempt-binding.ts (T03), not here.
    console.log("Scenario 3: Same-attempt authorize retry allowed");
    const auth = authResult1.authorization!;
    const attempt1 = "attempt-p6-1-primary";

    const firstAuth = await enforcement.authorizeExecution(
      auth.authorizationId,
      auth.releaseId,
      auth.artifactId,
      auth.commitSha,
      auth.environment,
      attempt1
    );
    console.log(`First authorize:\nExpected: AUTHORIZED\nActual: ${firstAuth.status}\n`);
    if (firstAuth.status !== "AUTHORIZED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    const retryAuth = await enforcement.authorizeExecution(
      auth.authorizationId,
      auth.releaseId,
      auth.artifactId,
      auth.commitSha,
      auth.environment,
      attempt1
    );
    console.log(`Same-attempt retry:\nExpected: AUTHORIZED\nActual: ${retryAuth.status}\n`);
    if (retryAuth.status !== "AUTHORIZED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    // Scenario 4: Deployment provider unavailable
    console.log("Scenario 4: Deployment provider unavailable");
    const freshAuthResult = await enforcement.requestRelease({
      releaseId: rel1,
      executionId: "exec-p6-1",
      artifactId: "artifact-p6-1",
      artifactDigest: digest1,
      commitSha: "commit1",
      environment: "production",
      approval: approval1,
      execution: exec1,
    });

    if (freshAuthResult.status !== "AUTHORIZED" || !freshAuthResult.authorization) {
      console.log("Failed to obtain fresh authorization for deployment test");
      process.exitCode = 1;
      return;
    }

    const deployResult = await enforcement.executeRelease(
      freshAuthResult.authorization.authorizationId,
      freshAuthResult.authorization.releaseId,
      freshAuthResult.authorization.artifactId,
      freshAuthResult.authorization.commitSha,
      freshAuthResult.authorization.environment
    );

    console.log(`Expected: BLOCKED\nActual: ${deployResult.status}\n`);
    if (deployResult.status !== "BLOCKED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    console.log("✅ All critical Pass 6 scenarios passed.");
  } finally {
    // Diagnostic logging (optional)
    const handles = (process as any)._getActiveHandles();
    const requests = (process as any)._getActiveRequests();
    console.log("\nActive handles:");
    for (const h of handles) {
      console.log("  -", h?.constructor?.name, h?.type || "", h?.remoteAddress || "", h?.remotePort || "");
    }
    console.log("Active requests:");
    for (const r of requests) {
      console.log("  -", r?.constructor?.name, r?.type || "", r?.remoteAddress || "", r?.remotePort || "");
    }

    // Cleanup engine
    const engineAny = engine as any;
    if (typeof engineAny.close === "function") {
      await engineAny.close();
    } else if (typeof engineAny.stop === "function") {
      await engineAny.stop();
    }
  }

  // Ensure process exits cleanly
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
