// scripts/test-phase173-release-recovery-crash-safety.ts
//
// Phase 173 - durable release recovery & unknown-outcome safety.
//
// Real SQLite + real ExecutionStore + real intent service + real enforcement
// service. Provider is a test double used only to drive call counts and
// reconcile outcomes. Never fabricates DEPLOYED without a durable intent
// transition. No fake approvals, no fake project ownership.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ProductionReleaseEnforcementService } from "../src/core/production-release-enforcement";
import type {
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ProviderReconciliationResult,
} from "../src/core/production-release-enforcement";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import type { AuditService } from "../src/core/audit";

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

function mkAuditSpy(calls: AuditCall[]): AuditService {
  return {
    record: async (entry: any) => {
      calls.push({
        action: entry.action,
        result: entry.result,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id,
        metadata: entry.metadata ?? {},
      });
    },
  } as unknown as AuditService;
}

function mkDecisionStub(): any {
  return { decide: async () => ({ status: "ALLOW", blockers: [], reasons: [] }) };
}

interface H { raw: Database.Database; engine: SQLiteEngine; store: ExecutionStore; }

function mkHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  return { raw, engine, store };
}

function seedExecution(h: H, executionId: string, projectId: string) {
  h.raw.prepare("INSERT OR REPLACE INTO nexus_records (store, key, value) VALUES (?, ?, ?)")
    .run("executions", executionId, JSON.stringify({ id: executionId, project_id: projectId, status: "RUNNING" }));
  const jobId = "job-" + executionId;
  const attemptId = "att-" + executionId;
  h.store.createJob({
    id: jobId, idempotencyKey: "k-" + jobId, jobType: "engineering",
    payload: { kind: "engineering", executionId }, status: "QUEUED",
    createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
  h.store.createAttempt({
    id: attemptId, jobId, attemptNumber: 1, status: "RUNNING",
    workerId: "w-test", leaseId: "L-test",
    startedAt: Date.now(), createdAt: Date.now(),
  } as any);
  return { jobId, attemptId };
}

function seedAuth(h: H, o: any): void {
  h.store.createProductionAuthorization({
    authorizationId: o.authorizationId, releaseId: o.releaseId,
    artifactId: o.artifactId, artifactDigest: o.artifactDigest,
    commitSha: o.commitSha, environment: o.environment,
    securityDecisionId: "sd-1", approvalId: "ap-1",
    executionId: o.executionId ?? null, projectId: o.projectId ?? null,
    imageRepository: null, imageTag: null, imageId: null,
    containerName: null, containerPort: null,
    issuedAt: new Date().toISOString(),
    expiresAt: o.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    consumedAt: o.consumedAt ?? null,
    consumedByAttemptId: o.consumedByAttemptId ?? null,
    revokedAt: o.revokedAt ?? null,
  } as any);
}

function mkIntentInput(prefix: string) {
  return {
    releaseId: "rel-" + prefix, executionId: "exec-" + prefix, attemptId: "att-" + prefix,
    artifactId: "art-" + prefix, artifactDigest: "sha256:" + prefix, commitSha: "c-" + prefix,
    environment: "production", projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix, imageTag: "v1", imageId: null,
    imageDigest: "sha256:" + prefix, containerName: "c-" + prefix, containerPort: 8080,
  };
}

async function main() {
  // === A. Provider unknown outcome ===
  section("A - Provider unknown outcome");
  {
    const h = mkHarness();
    const { attemptId } = seedExecution(h, "rel-A1", "proj-A1");
    seedAuth(h, { authorizationId: "auth-A1", releaseId: "rel-A1", artifactId: "art-A1", artifactDigest: "sha256:A1", commitSha: "c-A1", environment: "production" });
    const auditCalls: AuditCall[] = [];
    const provider: ReleaseExecutionProvider = {
      execute: async () => { throw new Error("ECONNRESET: connection lost"); },
    };
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.store, undefined, mkAuditSpy(auditCalls));
    const r = await enf.executeRelease("auth-A1", "rel-A1", "art-A1", "c-A1", "production", attemptId);
    ok(r.status === "RECOVERY_REQUIRED", "A1 provider throw -> RECOVERY_REQUIRED");
    ok(r.status !== "FAIL", "A2 provider throw is not definitive failure");
    ok(r.status !== "DEPLOYED", "A3 provider throw is not success");
    ok(/outcome unknown/.test(r.message), "A4 message preserves uncertainty");
    ok(auditCalls.some((c) => c.action === "release.execution.provider_unknown"), "A5 provider_unknown audit emitted");
  }
  {
    const h = mkHarness();
    const { attemptId } = seedExecution(h, "rel-A2", "proj-A2");
    seedAuth(h, { authorizationId: "auth-A2", releaseId: "rel-A2", artifactId: "art-A2", artifactDigest: "sha256:A2", commitSha: "c-A2", environment: "production" });
    const provider: ReleaseExecutionProvider = {
      execute: async () => ({ status: "DEPLOYED", message: "ok", deploymentId: "dep-A2" }),
    };
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.store);
    const r = await enf.executeRelease("auth-A2", "rel-A2", "art-A2", "c-A2", "production", attemptId);
    ok(r.status === "DEPLOYED", "A6 provider DEPLOYED propagated");
  }
  {
    const h = mkHarness();
    const { attemptId } = seedExecution(h, "rel-A3", "proj-A3");
    seedAuth(h, { authorizationId: "auth-A3", releaseId: "rel-A3", artifactId: "art-A3", artifactDigest: "sha256:A3", commitSha: "c-A3", environment: "production" });
    const provider: ReleaseExecutionProvider = {
      execute: async () => ({ status: "FAIL", message: "image pull failed" }),
    };
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.store);
    const r = await enf.executeRelease("auth-A3", "rel-A3", "art-A3", "c-A3", "production", attemptId);
    ok(r.status === "FAIL", "A7 definitive provider FAIL propagated");
  }

  // === B. Provider reconciliation contract ===
  section("B - Provider reconciliation contract");
  {
    const providerWithReconcile: ReleaseExecutionProvider = {
      execute: async () => ({ status: "DEPLOYED", message: "ok" }),
      reconcile: async (_req: ReleaseExecutionRequest): Promise<ProviderReconciliationResult> => ({
        status: "DEPLOYED", deploymentId: "dep-recon", message: "confirmed",
      }),
    };
    ok(typeof providerWithReconcile.reconcile === "function", "B1 provider with reconcile() is valid");
    const rec = await providerWithReconcile.reconcile!({ attemptId: "a" } as any);
    ok(rec.status === "DEPLOYED", "B2 reconcile returns DEPLOYED");
  }
  {
    const providerNoReconcile: ReleaseExecutionProvider = {
      execute: async () => ({ status: "DEPLOYED", message: "ok" }),
    };
    ok(providerNoReconcile.reconcile === undefined, "B3 provider without reconcile() still valid");
  }
  {
    // UNKNOWN verdict typecheck
    const p: ReleaseExecutionProvider = {
      execute: async () => ({ status: "RECOVERY_REQUIRED", message: "r" }),
      reconcile: async () => ({ status: "UNKNOWN", message: "unknown" }),
    };
    const rec = await p.reconcile!({} as any);
    ok(rec.status === "UNKNOWN", "B4 reconcile UNKNOWN is a valid verdict");
  }

  // === C. Authorization / attempt fencing ===
  section("C - Authorization / attempt fencing");
  {
    const h = mkHarness();
    seedAuth(h, { authorizationId: "auth-C1", releaseId: "rel-C1", artifactId: "art-C1", artifactDigest: "sha256:C1", commitSha: "c-C1", environment: "production", consumedAt: new Date().toISOString(), consumedByAttemptId: "att-OTHER" });
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.authorizeExecution("auth-C1", "rel-C1", "art-C1", "c-C1", "production", "att-MINE");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization replay detected"), "C1 different-attempt replay blocked");
  }
  {
    const h = mkHarness();
    seedAuth(h, { authorizationId: "auth-C2", releaseId: "rel-C2", artifactId: "art-C2", artifactDigest: "sha256:C2", commitSha: "c-C2", environment: "production", consumedAt: new Date().toISOString(), consumedByAttemptId: "att-SAME" });
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.authorizeExecution("auth-C2", "rel-C2", "art-C2", "c-C2", "production", "att-SAME");
    ok(r.status === "AUTHORIZED", "C2 same-attempt retry authorized");
  }
  {
    const h = mkHarness();
    seedAuth(h, { authorizationId: "auth-C3", releaseId: "rel-C3", artifactId: "art-C3", artifactDigest: "sha256:C3", commitSha: "c-C3", environment: "production", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.authorizeExecution("auth-C3", "rel-C3", "art-C3", "c-C3", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization expired"), "C3 expired authorization blocked");
  }
  {
    const h = mkHarness();
    seedAuth(h, { authorizationId: "auth-C3b", releaseId: "rel-C3b", artifactId: "art-C3b", artifactDigest: "sha256:C3b", commitSha: "c-C3b", environment: "production", revokedAt: new Date().toISOString() });
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.authorizeExecution("auth-C3b", "rel-C3b", "art-C3b", "c-C3b", "production", "att-X");
    ok(r.status === "BLOCKED" && r.reasons.includes("Authorization revoked"), "C3b revoked authorization blocked");
  }
  {
    const h = mkHarness();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.executeRelease("auth-C4", "rel-C4", "art-C4", "c-C4", "production", "");
    ok(r.status === "BLOCKED" && r.message.includes("attempt identity"), "C4 empty attemptId blocked");
  }
  {
    const h = mkHarness();
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), undefined, h.store);
    const r = await enf.executeRelease("auth-C5", "rel-C5", "art-C5", "c-C5", "production", "att-nonexistent");
    ok(r.status === "BLOCKED" && r.message.includes("not a durable ExecutionAttempt"), "C5 nonexistent attempt blocked");
  }
  {
    const h = mkHarness();
    const { attemptId } = seedExecution(h, "rel-C6-real", "proj-C6");
    seedAuth(h, { authorizationId: "auth-C6", releaseId: "rel-C6-WRONG", artifactId: "art-C6", artifactDigest: "sha256:C6", commitSha: "c-C6", environment: "production" });
    let providerCalls = 0;
    const provider: ReleaseExecutionProvider = { execute: async () => { providerCalls++; return { status: "DEPLOYED", message: "x" }; } };
    const enf = new ProductionReleaseEnforcementService({} as any, {} as any, mkDecisionStub(), provider, h.store);
    const r = await enf.executeRelease("auth-C6", "rel-C6-WRONG", "art-C6", "c-C6", "production", attemptId);
    ok(r.status === "BLOCKED" && r.message.includes("does not belong to execution"), "C6 job/execution mismatch blocked");
    ok(providerCalls === 0, "C7 zero provider calls on attempt mismatch");
  }

  // === D. Lease / stale worker safety ===
  section("D - Lease / stale worker safety");
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("D1") as any);
    const leaseA = intents.acquireLease(intent.intentKey, "worker-A");
    ok(leaseA.acquired === true, "D1 worker A acquires lease");
    const leaseB = intents.acquireLease(intent.intentKey, "worker-B");
    ok(leaseB.acquired === false, "D2 worker B cannot acquire same lease");
    ok(leaseB.holder === "worker-A", "D3 lease holder is worker A");
    intents.releaseLease(intent.intentKey, "worker-A");
    const leaseB2 = intents.acquireLease(intent.intentKey, "worker-B");
    ok(leaseB2.acquired === true, "D4 after release, worker B acquires");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("D2") as any);
    intents.acquireLease(intent.intentKey, "worker-A", 50);
    await new Promise((r) => setTimeout(r, 120));
    const leaseB = intents.acquireLease(intent.intentKey, "worker-B");
    ok(leaseB.acquired === true, "D5 expired lease permits re-acquire");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("D3") as any);
    intents.acquireLease(intent.intentKey, "worker-A");
    const releasedByB = intents.releaseLease(intent.intentKey, "worker-B");
    ok(releasedByB === false, "D6 stale worker cannot release another's lease");
    const renewed = intents.renewLease(intent.intentKey, "worker-A");
    ok(renewed === true, "D7 valid worker can renew its lease");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("D4") as any);
    intents.acquireLease(intent.intentKey, "worker-A");
    const renewedByB = intents.renewLease(intent.intentKey, "worker-B");
    ok(renewedByB === false, "D8 stale worker cannot renew another's lease");
  }

  // === E. Intent idempotency ===
  section("E - Intent idempotency");
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const input = mkIntentInput("E1");
    const r1 = await intents.getOrCreate(input as any);
    const r2 = await intents.getOrCreate(input as any);
    ok(r1.created === true, "E1 first getOrCreate creates");
    ok(r2.created === false, "E2 second getOrCreate is idempotent");
    ok(r1.intent.intentKey === r2.intent.intentKey, "E3 same intentKey");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const input1 = mkIntentInput("E2");
    const input2 = { ...input1, attemptId: input1.attemptId + "-B" };
    const r1 = await intents.getOrCreate(input1 as any);
    const r2 = await intents.getOrCreate(input2 as any);
    ok(r1.intent.intentKey !== r2.intent.intentKey, "E4 different attemptId -> different intentKey");
    ok(r2.created === true, "E5 second attempt creates a distinct intent (authorization fencing applies at executeRelease)");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const input1 = mkIntentInput("E3");
    const input2 = { ...input1, releaseId: input1.releaseId + "-X" };
    const r1 = await intents.getOrCreate(input1 as any);
    const r2 = await intents.getOrCreate(input2 as any);
    ok(r1.intent.intentKey !== r2.intent.intentKey, "E6 different releaseId -> different intentKey");
  }

  // === F. Intent terminal transitions ===
  section("F - Intent terminal transitions");
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("F1") as any);
    intents.transition(intent.intentKey, "KNOWN_GOOD", { deploymentId: "dep-F1" });
    const fresh = intents.get(intent.intentKey);
    ok(fresh?.status === "KNOWN_GOOD", "F1 KNOWN_GOOD persisted");
    ok(fresh?.deploymentId === "dep-F1", "F2 deploymentId persisted");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("F2") as any);
    intents.transition(intent.intentKey, "RECOVERY_REQUIRED", { recoveryReason: "unknown provider outcome" });
    const fresh = intents.get(intent.intentKey);
    ok(fresh?.status === "RECOVERY_REQUIRED", "F3 RECOVERY_REQUIRED persisted");
    ok(fresh?.recoveryReason === "unknown provider outcome", "F4 recovery reason persisted");
  }
  {
    const h = mkHarness();
    const intents = new ReleaseDeploymentIntentService(h.store);
    const { intent } = await intents.getOrCreate(mkIntentInput("F3") as any);
    intents.transition(intent.intentKey, "BLOCKED", { failureReason: "auth mismatch" });
    const fresh = intents.get(intent.intentKey);
    ok(fresh?.status === "BLOCKED", "F5 BLOCKED persisted");
  }

  // === G. Recovery classifier ===
  section("G - Recovery classifier");
  {
    const recovery = new ReleaseRecoveryService();
    const base = {
      intentKey: "k", releaseId: "r", executionId: "e", artifactId: "a",
      artifactDigest: "sha256:x", commitSha: "c", environment: "production",
      projectId: "p", imageRepository: "i", imageTag: "v1", imageId: null,
      imageDigest: "sha256:x", containerName: "c", containerPort: 8080,
      deploymentId: null, failureReason: null, recoveryReason: null,
      leasedBy: null, leaseExpiresAt: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as any;
    const pDeploying = recovery.classify({ intent: { ...base, status: "DEPLOYING" } as any });
    ok(pDeploying.action === "RECOVERY_REQUIRED", "G1 DEPLOYING -> RECOVERY_REQUIRED");
    ok(pDeploying.requiresDockerInspection === true, "G2 DEPLOYING requires Docker inspection");

    const pKg = recovery.classify({ intent: { ...base, status: "KNOWN_GOOD", deploymentId: "dep-1" } as any });
    ok(pKg.action === "ALREADY_KNOWN_GOOD", "G3 KNOWN_GOOD terminal");

    const pRr = recovery.classify({ intent: { ...base, status: "RECOVERY_REQUIRED", recoveryReason: "prior" } as any });
    ok(pRr.action === "RECOVERY_REQUIRED", "G4 RECOVERY_REQUIRED stays RECOVERY_REQUIRED");

    const pFailed = recovery.classify({ intent: { ...base, status: "FAILED", failureReason: "x" } as any });
    ok(pFailed.action === "ALREADY_FAILED", "G5 FAILED terminal");

    const pBlocked = recovery.classify({ intent: { ...base, status: "BLOCKED", failureReason: "x" } as any });
    ok(pBlocked.action === "ALREADY_BLOCKED", "G6 BLOCKED terminal");
  }

  // === H. Restart durability ===
  section("H - Restart durability");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-p173-"));
    const dbFile = join(dir, "state.db");
    let intentKey: string | null = null;
    try {
      const h1 = mkHarness(dbFile);
      const intents1 = new ReleaseDeploymentIntentService(h1.store);
      const { intent } = await intents1.getOrCreate(mkIntentInput("H1") as any);
      intentKey = intent.intentKey;
      intents1.acquireLease(intent.intentKey, "worker-A", 60000);
      intents1.transition(intent.intentKey, "RECOVERY_REQUIRED", { recoveryReason: "unknown-provider-outcome" });
      h1.raw.close();

      const h2 = mkHarness(dbFile);
      const intents2 = new ReleaseDeploymentIntentService(h2.store);
      const fresh = intents2.get(intentKey!);
      ok(fresh !== undefined, "H1 intent survives restart");
      ok(fresh?.status === "RECOVERY_REQUIRED", "H2 RECOVERY_REQUIRED status survives restart");
      ok(fresh?.recoveryReason === "unknown-provider-outcome", "H3 recovery reason survives restart");
      ok(fresh?.leasedBy === "worker-A", "H4 lease owner survives restart");
      h2.raw.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log("\n=== Phase 173 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});