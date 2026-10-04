// scripts/test-phase246-release-review-enforcement.ts
// Phase 246 §6: prove REQUIRE_REVIEW cannot become ALLOW/AUTHORIZED
// in the production release path.
import Database from "better-sqlite3";
import path from "node:path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { SecurityApi } from "../src/core/security-api";
import { SecurityReleaseGate } from "../src/core/security-release-gate";
import { ProductionReleaseDecisionService } from "../src/core/production-release-decision";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }

const NINE_CATS = ["SAST","SCA","SECRET","IAC","CONTAINER","SBOM","DAST","SUPPLY_CHAIN","SIGNATURE"];

async function buildApi(): Promise<SecurityApi> {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const dbPath = path.join(os.tmpdir(), "nexus-p246-" + Date.now() + "-" + Math.random().toString(36).slice(2,8) + ".sqlite");
  const engine = await SQLiteEngine.open(dbPath);
  // clean on exit
  process.on("exit", () => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + e); } catch {} } });
  return await SecurityApi.create(engine);
}

async function seed(
  api: SecurityApi,
  executionId: string,
  opts: { medium?: boolean; artifactDigest: string },
): Promise<void> {
  const engine = (api as any).engine;
  // evidence: all 9 categories PASS
  for (const cat of NINE_CATS) {
    const ev: any = {
      id: "ev-" + executionId + "-" + cat,
      project_id: "p-" + executionId,
      execution_id: executionId,
      commit_sha: "c-" + executionId,
      artifact_digest: opts.artifactDigest,
      environment: "production",
      scanner: "test-" + cat,
      category: cat,
      status: "PASS",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 10,
      created_at: new Date().toISOString(),
    };
    await engine.put("security_evidence", ev.id, ev);
  }
  // finding: medium to trigger REVIEW
  if (opts.medium) {
    const f: any = {
      finding_id: "f-" + executionId,
      evidence_id: "ev-" + executionId + "-SCA",
      project_id: "p-" + executionId,
      execution_id: executionId,
      artifact_digest: opts.artifactDigest,
      scanner: "test",
      category: "SCA",
      severity: "MEDIUM",
      title: "Medium test finding",
      fingerprint: "fp-" + executionId,
      status: "OPEN",
      created_at: new Date().toISOString(),
    };
    await engine.put("security_findings", f.finding_id, f);
  }
  // execution record needed by gate's getExecution lookup
  const exec: any = {
    id: executionId,
    project_id: "p-" + executionId,
    execution_id: executionId,
    commit_sha: "c-" + executionId,
    artifact_digest: opts.artifactDigest,
    release_id: "rel-" + executionId,
    status: "RUNNING",
    started_at: new Date().toISOString(),
  };
  await engine.put("security_executions", exec.id, exec);
}

async function main() {
  // ---------- A13: REQUIRE_REVIEW flows through production decision ----------
  section("A13 - production-release-decision preserves REQUIRE_REVIEW");
  {
    const api = await buildApi();
    const gate = new SecurityReleaseGate(api);
    const prd = new ProductionReleaseDecisionService(api, gate);

    const executionId = "p246-rev-" + Date.now();
    const digest = "sha256-test-" + executionId;
    await seed(api, executionId, { medium: true, artifactDigest: digest });

    const result = await prd.decide({
      releaseId: "rel-" + executionId,
      executionId,
      artifactId: "art-" + executionId,
      artifactDigest: digest,
      environment: "production",
      approval: {
        releaseId: "rel-" + executionId,
        artifactId: "art-" + executionId,
        artifactDigest: digest,
        environment: "production",
        approver: "test",
        approvedAt: new Date().toISOString(),
        status: "APPROVED",
      },
      execution: {
        id: executionId,
        project_id: "p-" + executionId,
        execution_id: executionId,
        commit_sha: "c-" + executionId,
        artifact_digest: digest,
        release_id: "rel-" + executionId,
        status: "RUNNING",
        started_at: new Date().toISOString(),
      },
    });

    ok(result.status === "REQUIRE_REVIEW",
       "A13 decision.status=REQUIRE_REVIEW (got " + result.status + ")");
    ok(result.canonicalSecurityStatus === "REQUIRE_REVIEW",
       "A13 canonicalSecurityStatus=REQUIRE_REVIEW (got " + result.canonicalSecurityStatus + ")");
    ok(result.status !== "ALLOW",
       "A13 REQUIRE_REVIEW did not become ALLOW");
  }

  // ---------- A14: enforcement preserves REQUIRE_REVIEW ----------
  section("A14 - production-release-enforcement preserves REQUIRE_REVIEW");
  {
    const api = await buildApi();
    const gate = new SecurityReleaseGate(api);
    const prd = new ProductionReleaseDecisionService(api, gate);
    const pre = new ProductionReleaseEnforcementService(api, gate, prd);

    const executionId = "p246-enf-" + Date.now();
    const digest = "sha256-enf-" + executionId;
    await seed(api, executionId, { medium: true, artifactDigest: digest });

    const authResult = await pre.requestRelease({
      releaseId: "rel-" + executionId,
      executionId,
      artifactId: "art-" + executionId,
      artifactDigest: digest,
      commitSha: "c-" + executionId,
      environment: "production",
      approval: {
        releaseId: "rel-" + executionId,
        artifactId: "art-" + executionId,
        artifactDigest: digest,
        environment: "production",
        approver: "test",
        approvedAt: new Date().toISOString(),
        status: "APPROVED",
      },
      execution: {
        id: executionId,
        project_id: "p-" + executionId,
        execution_id: executionId,
        commit_sha: "c-" + executionId,
        artifact_digest: digest,
        release_id: "rel-" + executionId,
        status: "RUNNING",
        started_at: new Date().toISOString(),
      },
    });

    ok(authResult.status === "REQUIRE_REVIEW",
       "A14 enforcement.status=REQUIRE_REVIEW (got " + authResult.status + ")");
    ok(authResult.status !== "AUTHORIZED",
       "A14 REQUIRE_REVIEW did not become AUTHORIZED");
    ok(authResult.authorization === undefined,
       "A14 no authorization issued for REQUIRE_REVIEW");
  }

  // ---------- A15: ALLOW still works when clean ----------
  section("A15 - clean scenario still reaches ALLOW/AUTHORIZED");
  {
    const api = await buildApi();
    const gate = new SecurityReleaseGate(api);
    const prd = new ProductionReleaseDecisionService(api, gate);

    const executionId = "p246-ok-" + Date.now();
    const digest = "sha256-ok-" + executionId;
    await seed(api, executionId, { medium: false, artifactDigest: digest });

    const result = await prd.decide({
      releaseId: "rel-" + executionId,
      executionId,
      artifactId: "art-" + executionId,
      artifactDigest: digest,
      environment: "production",
      approval: {
        releaseId: "rel-" + executionId,
        artifactId: "art-" + executionId,
        artifactDigest: digest,
        environment: "production",
        approver: "test",
        approvedAt: new Date().toISOString(),
        status: "APPROVED",
      },
      execution: {
        id: executionId,
        project_id: "p-" + executionId,
        execution_id: executionId,
        commit_sha: "c-" + executionId,
        artifact_digest: digest,
        release_id: "rel-" + executionId,
        status: "RUNNING",
        started_at: new Date().toISOString(),
      },
    });

    ok(result.status === "ALLOW", "A15 clean decision.status=ALLOW (got " + result.status + ")");
    ok(result.canonicalSecurityStatus === "ALLOW",
       "A15 canonicalSecurityStatus=ALLOW (got " + result.canonicalSecurityStatus + ")");
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });