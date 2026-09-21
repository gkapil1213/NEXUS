// scripts/test-phase172-production-release-execution-safety.ts
//
// Phase 172 - production release execution safety, environment policy,
// deployment authority. Real SQLite + real ExecutionStore. The provider
// is a spy (deterministic). Audit sink is a capturing stub. No fake
// deployments, no fake approvals; every block path is proven to reach
// zero provider calls.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import type { AuditService } from "../src/core/audit";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import type {
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
} from "../src/core/production-release-enforcement";
import { policyFor, isKnownEnvironment } from "../src/core/environment-policy";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

interface AuditCall {
  action: string;
  result: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
}
interface Harness {
  db: Database.Database;
  engine: SQLiteEngine;
  execStore: ExecutionStore;
}

function makeHarness(): Harness {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const execStore = new ExecutionStore(raw);
  return { db: raw, engine, execStore };
}

function mkAuditSpy(calls: AuditCall[]): AuditService {
  const stub: any = {
    record: async (entry: any) => {
      calls.push({
        action: entry.action,
        result: entry.result,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id,
        metadata: entry.metadata ?? {},
      });
    },
  };
  return stub as AuditService;
}

function mkProviderSpy(): { provider: ReleaseExecutionProvider; calls: ReleaseExecutionRequest[] } {
  const calls: ReleaseExecutionRequest[] = [];
  const provider: ReleaseExecutionProvider = {
    execute: async (req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> => {
      calls.push(req);
      return { status: "DEPLOYED", message: "spy deployed", deploymentId: "dep-spy-1" };
    },
  };
  return { provider, calls };
}

function mkDecisionStub(): any {
  return { decide: async () => ({ status: "ALLOW", blockers: [], reasons: [] }) };
}

function seedExecution(h: Harness, executionId: string, projectId: string): { jobId: string; attemptId: string } {
  h.db
    .prepare("INSERT OR REPLACE INTO nexus_records (store, key, value) VALUES (?, ?, ?)")
    .run("executions", executionId, JSON.stringify({ id: executionId, project_id: projectId, status: "RUNNING" }));

  const jobId = "job-" + executionId;
  const attemptId = "att-" + executionId;
  h.execStore.createJob({
    id: jobId,
    idempotencyKey: "k-" + jobId,
    jobType: "engineering",
    payload: { kind: "engineering", executionId },
    status: "QUEUED",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cancellationRequested: false,
    cancellationAcknowledged: false,
  } as any);
  h.execStore.createAttempt({
    id: attemptId,
    jobId,
    attemptNumber: 1,
    status: "RUNNING",
    workerId: "w-test",
    leaseId: "L-test",
    startedAt: Date.now(),
    createdAt: Date.now(),
  } as any);
  return { jobId, attemptId };
}

function seedAuthorization(
  h: Harness,
  opts: {
    authorizationId: string;
    releaseId: string;
    artifactId: string;
    artifactDigest: string;
    commitSha: string;
    environment: string;
    expiresAt?: string;
    revokedAt?: string | null;
    consumedAt?: string | null;
    consumedByAttemptId?: string | null;
  },
): void {
  const expires = opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  h.execStore.createProductionAuthorization({
    authorizationId: opts.authorizationId,
    releaseId: opts.releaseId,
    artifactId: opts.artifactId,
    artifactDigest: opts.artifactDigest,
    commitSha: opts.commitSha,
    environment: opts.environment,
    securityDecisionId: "sd-1",
    approvalId: "ap-1",
    executionId: null,
    projectId: null,
    imageRepository: null,
    imageTag: null,
    imageId: null,
    containerName: null,
    containerPort: null,
    issuedAt: new Date().toISOString(),
    expiresAt: expires,
    consumedAt: opts.consumedAt ?? null,
    consumedByAttemptId: opts.consumedByAttemptId ?? null,
    revokedAt: opts.revokedAt ?? null,
  } as any);
}

async function main() {
  const h = makeHarness();

  // ================= A. Environment policy =================
  section("A - Environment policy (pure)");
  ok(policyFor("production").isProduction === true, "A1 production isProduction=true");
  ok(policyFor("production").requiresApproval === true, "A2 production requiresApproval=true");
  ok(policyFor("production").requiresAttemptIdentity === true, "A3 production requiresAttemptIdentity=true");
  ok(policyFor("staging").isProduction === false, "A4 staging isProduction=false");
  ok(policyFor("staging").requiresApproval === true, "A5 staging requiresApproval=true");
  ok(policyFor("development").requiresApproval === false, "A6 development requiresApproval=false");
  ok(policyFor("development").requiresImmutableImage === true, "A7 development still requiresImmutableImage=true");
  const unknown = policyFor("wat");
  ok(unknown.isProduction === true, "A8 unknown env fail-closed isProduction=true");
  ok(unknown.requiresApproval === true, "A9 unknown env fail-closed requiresApproval=true");
  ok(unknown.name === "wat", "A10 unknown env preserves name");
  ok(isKnownEnvironment("production") === true, "A11 known production");
  ok(isKnownEnvironment("staging") === true, "A12 known staging");
  ok(isKnownEnvironment("development") === true, "A13 known development");
  ok(isKnownEnvironment("wat") === false, "A14 unknown not known");

  // ================= B. Authorization binding =================
  section("B - Authorization binding");

  seedAuthorization(h, { authorizationId: "auth-B1", releaseId: "rel-B1", artifactId: "art-B1", artifactDigest: "sha256:B1", commitSha: "c-B1", environment: "production" });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B1", "rel-B1", "art-B1", "c-B1", "production", "any-attempt");
    ok(r.status === "AUTHORIZED", "B1 valid authorization accepted");
  }
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-missing", "rel-X", "art-X", "c-X", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization not found"), "B2 unknown authorization blocked");
  }
  seedAuthorization(h, { authorizationId: "auth-B3", releaseId: "rel-B3", artifactId: "art-B3", artifactDigest: "sha256:B3", commitSha: "c-B3", environment: "production" });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B3", "rel-OTHER", "art-B3", "c-B3", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.some((x) => x.includes("binding mismatch")), "B3 releaseId mismatch blocked");
  }
  seedAuthorization(h, { authorizationId: "auth-B4", releaseId: "rel-B4", artifactId: "art-B4", artifactDigest: "sha256:B4", commitSha: "c-B4", environment: "staging" });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B4", "rel-B4", "art-B4", "c-B4", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.some((x) => x.includes("binding mismatch")), "B4 staging auth -> production blocked (escalation)");
  }
  seedAuthorization(h, { authorizationId: "auth-B5", releaseId: "rel-B5", artifactId: "art-B5", artifactDigest: "sha256:B5", commitSha: "c-B5", environment: "production", expiresAt: new Date(Date.now() - 1000).toISOString() });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B5", "rel-B5", "art-B5", "c-B5", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization expired"), "B5 expired authorization blocked");
  }
  seedAuthorization(h, { authorizationId: "auth-B6", releaseId: "rel-B6", artifactId: "art-B6", artifactDigest: "sha256:B6", commitSha: "c-B6", environment: "production", revokedAt: new Date().toISOString() });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B6", "rel-B6", "art-B6", "c-B6", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization revoked"), "B6 revoked authorization blocked");
  }
  seedAuthorization(h, { authorizationId: "auth-B7", releaseId: "rel-B7", artifactId: "art-B7", artifactDigest: "sha256:B7", commitSha: "c-B7", environment: "production", consumedAt: new Date().toISOString(), consumedByAttemptId: "att-OTHER" });
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-B7", "rel-B7", "art-B7", "c-B7", "production", "att-MINE");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization replay detected"), "B7 consumed-by-other-attempt blocked");
  }

  // ================= C. Attempt binding =================
  section("C - Attempt binding");
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.executeRelease("auth-C1", "rel-C1", "art-C1", "c-C1", "production", "");
    ok(r.status === "BLOCKED" && r.message.includes("attempt identity"), "C1 empty attemptId blocked");
  }
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.executeRelease("auth-C2", "rel-C2", "art-C2", "c-C2", "production", "att-does-not-exist");
    ok(r.status === "BLOCKED" && r.message.includes("not a durable ExecutionAttempt"), "C2 nonexistent attempt blocked");
  }
  {
    const { attemptId } = seedExecution(h, "rel-C3", "proj-C3");
    seedAuthorization(h, { authorizationId: "auth-C3", releaseId: "rel-C3", artifactId: "art-C3", artifactDigest: "sha256:C3", commitSha: "c-C3", environment: "production" });
    const { provider, calls } = mkProviderSpy();
    const auditCalls: AuditCall[] = [];
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.execStore, undefined, mkAuditSpy(auditCalls));
    const r = await enf.executeRelease("auth-C3", "rel-C3", "art-C3", "c-C3", "production", attemptId);
    ok(r.status === "DEPLOYED", "C3 valid chain reached provider");
    ok(calls.length === 1, "C3b provider invoked exactly once");
    ok(auditCalls.some((c) => c.action === "release.authorization.accepted"), "C3c authorization accepted audited");
    ok(auditCalls.some((c) => c.action === "provider.execution.permitted"), "C3d provider permitted audited");
  }
  {
    const { attemptId } = seedExecution(h, "rel-C4-real", "proj-C4");
    seedAuthorization(h, { authorizationId: "auth-C4", releaseId: "rel-C4-WRONG", artifactId: "art-C4", artifactDigest: "sha256:C4", commitSha: "c-C4", environment: "production" });
    const { provider, calls } = mkProviderSpy();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.execStore);
    const r = await enf.executeRelease("auth-C4", "rel-C4-WRONG", "art-C4", "c-C4", "production", attemptId);
    ok(r.status === "BLOCKED" && r.message.includes("does not belong to execution"), "C4 job/execution mismatch blocked");
    ok(calls.length === 0, "C4b provider not invoked");
  }

  // ================= D. Provider fencing =================
  section("D - Provider fencing");
  {
    const { attemptId } = seedExecution(h, "rel-D1", "proj-D1");
    seedAuthorization(h, { authorizationId: "auth-D1", releaseId: "rel-D1", artifactId: "art-D1", artifactDigest: "sha256:D1", commitSha: "c-D1", environment: "production" });
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.executeRelease("auth-D1", "rel-D1", "art-D1", "c-D1", "production", attemptId);
    ok(r.status === "BLOCKED" && r.providerAvailable === false, "D1 no provider -> BLOCKED");
  }
  {
    const { attemptId } = seedExecution(h, "rel-D2", "proj-D2");
    seedAuthorization(h, { authorizationId: "auth-D2", releaseId: "rel-D2-OTHER", artifactId: "art-D2", artifactDigest: "sha256:D2", commitSha: "c-D2", environment: "production" });
    const { provider, calls } = mkProviderSpy();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.execStore);
    const r = await enf.executeRelease("auth-D2", "rel-D2", "art-D2", "c-D2", "production", attemptId);
    ok(r.status === "BLOCKED", "D2 auth mismatch blocked");
    ok(calls.length === 0, "D2b provider calls = 0");
  }

  // ================= E. Audit emission =================
  section("E - Audit emission");
  {
    const auditCalls: AuditCall[] = [];
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore, undefined, mkAuditSpy(auditCalls));
    await enf.authorizeExecution("auth-E1-missing", "rel-E1", "art-E1", "c-E1", "production", "att-E1");
    ok(
      auditCalls.length === 1 &&
        auditCalls[0].action === "release.authorization.rejected" &&
        auditCalls[0].metadata.reason === "authorization_not_found",
      "E1 not-found emits release.authorization.rejected",
    );
  }
  {
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore);
    const r = await enf.authorizeExecution("auth-E2-missing", "rel-E2", "art-E2", "c-E2", "production", "att-E2");
    ok(r.status === "BLOCKED", "E2 no audit wired -> decision still produced");
  }
  {
    const { attemptId } = seedExecution(h, "rel-E3", "proj-E3");
    seedAuthorization(h, { authorizationId: "auth-E3", releaseId: "rel-E3", artifactId: "art-E3", artifactDigest: "sha256:E3", commitSha: "c-E3", environment: "production" });
    const auditCalls: AuditCall[] = [];
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.execStore, undefined, mkAuditSpy(auditCalls));
    await enf.executeRelease("auth-E3", "rel-E3", "art-E3", "c-E3", "production", attemptId);
    ok(auditCalls.some((c) => c.action === "provider.execution.blocked"), "E3 no-provider emits provider.execution.blocked");
  }

  // ================= F. Attempt consumption =================
  section("F - Attempt consumption");
  {
    const { attemptId } = seedExecution(h, "rel-F1", "proj-F1");
    seedAuthorization(h, { authorizationId: "auth-F1", releaseId: "rel-F1", artifactId: "art-F1", artifactDigest: "sha256:F1", commitSha: "c-F1", environment: "production" });
    const { provider, calls } = mkProviderSpy();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.execStore);
    const r1 = await enf.executeRelease("auth-F1", "rel-F1", "art-F1", "c-F1", "production", attemptId);
    ok(r1.status === "DEPLOYED", "F1 first execution succeeds");
    const r2 = await enf.executeRelease("auth-F1", "rel-F1", "art-F1", "c-F1", "production", attemptId);
    ok(r2.status === "DEPLOYED", "F2 same-attempt retry succeeds");
    ok(calls.length === 2, "F3 provider called twice for same attempt (bridge enforces intent idempotency)");
  }
  {
    const { attemptId: attA, jobId } = seedExecution(h, "rel-F2A", "proj-F2");
    h.execStore.createAttempt({
      id: "att-F2B",
      jobId,
      attemptNumber: 2,
      status: "RUNNING",
      workerId: "w2",
      leaseId: "L2",
      startedAt: Date.now(),
      createdAt: Date.now(),
    } as any);
    seedAuthorization(h, { authorizationId: "auth-F2", releaseId: "rel-F2A", artifactId: "art-F2", artifactDigest: "sha256:F2", commitSha: "c-F2", environment: "production" });
    const { provider, calls } = mkProviderSpy();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.execStore);
    const r1 = await enf.executeRelease("auth-F2", "rel-F2A", "art-F2", "c-F2", "production", attA);
    ok(r1.status === "DEPLOYED", "F4 first attempt deployed");
    const r2 = await enf.executeRelease("auth-F2", "rel-F2A", "art-F2", "c-F2", "production", "att-F2B");
ok(r2.status === "BLOCKED" && /replay|different attempt/i.test(r2.message), "F5 different attempt blocked");
    ok(calls.length === 1, "F6 provider called only once");
  }

  console.log("\n=== Phase 172 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
