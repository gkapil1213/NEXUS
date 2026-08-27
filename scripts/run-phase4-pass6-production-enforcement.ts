import { openEngine } from "../src/core/db";
import { SecurityApi } from "../src/core/security-api";
import { SecurityScannerRunner } from "../src/core/security-scanner-runner";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import {
  ProductionReleaseDecisionService,
  ProductionApproval,
} from "../src/core/production-release-decision";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";

async function main() {
  const engine = await openEngine();
  const api = new SecurityApi(engine);
  const runner = new SecurityScannerRunner(engine, api);
  const gate = new SecurityReleaseGate(api);
  const decisionService = new ProductionReleaseDecisionService(api, gate);
  const enforcement = new ProductionReleaseEnforcementService(api, gate, decisionService);

  console.log("=== Phase 4 Pass 6: Production Release Enforcement ===\n");

  async function runScan(executionId: string, projectId: string, commit: string, artifactDigest?: string) {
    const exec = await api.startExecution(projectId, executionId, commit, artifactDigest, `rel_${executionId}`);
    await runner.runAll(executionId, projectId, commit, artifactDigest, `rel_${executionId}`);
    return exec;
  }

  try {
    // Scenario 1
    console.log("Scenario 1: Valid signed artifact + approval");
    const digest1 = "a".repeat(64);
    const exec1 = await runScan("exec-p6-1", "proj-p6", "commit1", digest1);
    const approval1: ProductionApproval = {
      releaseId: "rel-p6-1",
      artifactId: "artifact-p6-1",
      artifactDigest: digest1,
      environment: "production",
      approver: "owner",
      approvedAt: new Date().toISOString(),
      status: "APPROVED",
    };
    const authResult1 = await enforcement.requestRelease({
      releaseId: "rel-p6-1",
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

    // Scenario 2
    console.log("Scenario 2: Unsigned artifact");
    const exec2 = await runScan("exec-p6-2", "proj-p6", "commit2", undefined);
    const approval2: ProductionApproval = {
      ...approval1,
      releaseId: "rel-p6-2",
      artifactId: "artifact-p6-2",
      artifactDigest: "b".repeat(64),
      environment: "production",
    };
    const authResult2 = await enforcement.requestRelease({
      releaseId: "rel-p6-2",
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

    // Scenario 3: Replay authorization
    console.log("Scenario 3: Replay authorization");
    const auth = authResult1.authorization!;
    const firstAuth = await enforcement.authorizeExecution(
      auth.authorizationId,
      auth.releaseId,
      auth.artifactId,
      auth.commitSha,
      auth.environment,
    );
    console.log(`First execution:\nExpected: AUTHORIZED\nActual: ${firstAuth.status}\n`);
    if (firstAuth.status !== "AUTHORIZED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    const secondAuth = await enforcement.authorizeExecution(
      auth.authorizationId,
      auth.releaseId,
      auth.artifactId,
      auth.commitSha,
      auth.environment,
    );
    console.log(`Second execution:\nExpected: BLOCKED\nActual: ${secondAuth.status}\n`);
    if (secondAuth.status !== "BLOCKED") {
      console.log("FAILED");
      process.exitCode = 1;
      return;
    }
    console.log("PASS\n");

    // Scenario 4: Deployment provider unavailable
    console.log("Scenario 4: Deployment provider unavailable");
    const freshAuthResult = await enforcement.requestRelease({
      releaseId: "rel-p6-1",
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
      freshAuthResult.authorization.environment,
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
    // Diagnostic logging
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
    // no process.exit here; let Node exit naturally
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});