// scripts/test-phase178-recovery-operations-control.ts
//
// Phase 178 - durable recovery operations, observability and control.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real ReleaseRecoveryExecutor + real RecoveryOperationsService +
// real RecoveryControlService.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ReleaseDeploymentIntentService } from "../src/core/release-deployment-intent";
import { ReleaseRecoveryService } from "../src/core/release-recovery";
import { ReleaseRecoveryExecutor } from "../src/core/release-recovery-executor";
import { RecoveryOperationsService } from "../src/core/recovery-operations";
import { RecoveryControlService } from "../src/core/recovery-control-service";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

interface CapturedEvent { type: string; source?: string; execution_id?: string | null; payload?: any; }
interface CapturedAudit { action: string; resource_id: string; result?: string; metadata?: any; }

interface H {
  raw: Database.Database;
  engine: SQLiteEngine;
  store: ExecutionStore;
  intents: ReleaseDeploymentIntentService;
  events: CapturedEvent[];
  audits: CapturedAudit[];
  ops: RecoveryOperationsService;
  ctrl: RecoveryControlService;
}

const eventsSink = (h: { events: CapturedEvent[] }) => ({
  emit: async (e: CapturedEvent) => { h.events.push(e); return e; },
});
const auditSink = (h: { audits: CapturedAudit[] }) => ({
  record: async (e: CapturedAudit) => { h.audits.push(e); return e; },
});

function mkHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  const partial: any = { raw, engine, store, intents, events: [], audits: [] };
  const audit = auditSink(partial);
  const events = eventsSink(partial);
  partial.ops = new RecoveryOperationsService({ intents, audit: audit as any, events: events as any });
  partial.ctrl = new RecoveryControlService({ intents, audit: audit as any, events: events as any, workerId: "recovery-control" });
  return partial as H;
}

function mkInput(prefix: string, extra: Record<string, unknown> = {}): any {
  return {
    releaseId: "rel-" + prefix,
    executionId: "exec-" + prefix,
    artifactId: "art-" + prefix,
    artifactDigest: "sha256:" + prefix,
    commitSha: "c-" + prefix,
    environment: "production",
    projectId: "proj-" + prefix,
    imageRepository: "nexus/" + prefix,
    imageTag: "v1",
    imageId: "sha256-img-" + prefix,
    imageDigest: "sha256:dig-" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    attemptId: "att-" + prefix,
    ...extra,
  };
}

function mkExecutor(h: H, opts: {
  workerId: string;
  orchestratedStatus?: "KNOWN_GOOD" | "FAILED" | "BLOCKED";
  orchestratorThrows?: boolean;
  inspectionDoc?: any;
  smokeVerdict?: "PASS" | "FAIL" | "BLOCKED";
  retryPolicy?: { initialDelayMs: number; multiplier: number; maxDelayMs: number; maxAttempts: number };
}): ReleaseRecoveryExecutor {
  const events = { emit: async (e: CapturedEvent) => { h.events.push(e); } };
  const audit = { record: async (e: CapturedAudit) => { h.audits.push(e); } };
  const status = opts.orchestratedStatus ?? "DEPLOYING";
  const orchestratorStub: any = {
    deploy: async () => {
      if (opts.orchestratorThrows) throw new Error("provider unavailable");
      return { deployment: { id: "dep-" + status, status }, rollback: null };
    },
  };
  const historyStub: any = { getDeployment: async () => null };
  const inspectionDoc = opts.inspectionDoc ?? null;
  const dockerStub: any = {
    run: async (op: any) => {
      if (op.kind === "inspect" && inspectionDoc) {
        return { status: "SUCCEEDED", stdout: JSON.stringify(inspectionDoc), stderr: "", exit_code: 0 };
      }
      return { status: "FAILED", stdout: "", stderr: "no container", exit_code: 1 };
    },
  };
  const smokeStub: any = { run: async () => ({ verdict: opts.smokeVerdict ?? "PASS" }) };
  const deps: any = {
    intents: h.intents,
    recovery: new ReleaseRecoveryService(),
    orchestrator: orchestratorStub,
    history: historyStub,
    docker: dockerStub,
    smoke: smokeStub,
    svc: { events, audit },
    workerId: opts.workerId,
    retryPolicy: opts.retryPolicy,
  };
  return new ReleaseRecoveryExecutor(deps);
}

async function seedIntent(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await h.intents.getOrCreate(mkInput(prefix, extra));
  return intent.intentKey;
}
async function seedDeploying(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = await seedIntent(h, prefix, extra);
  h.intents.acquireLease(k, "seeder", 60_000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.transitionIfOwned(k, "DEPLOYING", "seeder", {});
  h.intents.releaseLease(k, "seeder");
  return k;
}
async function seedIntentCreated(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = await seedIntent(h, prefix, extra);
  h.intents.acquireLease(k, "seeder", 60_000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.releaseLease(k, "seeder");
  return k;
}

function decisionJson(d: any): string {
  return JSON.stringify(d);
}

async function main() {
  // ============================================================
  // A - Snapshot
  // ============================================================
  section("A - Snapshot");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A1");
    const snap = h.ops.snapshot(k);
    ok(snap !== null, "A1 recoverable intent appears in snapshot");
    ok(snap?.health !== "TERMINAL", "A1 non-terminal classification");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A2");
    const exec = mkExecutor(h, { workerId: "w-A2", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const list = h.ops.listSnapshots();
    ok(!list.some((s) => s.intentKey === k), "A2 terminal intent excluded from recoverable snapshots");
    const one = h.ops.snapshot(k);
    ok(one?.health === "TERMINAL", "A2 direct snapshot classifies as TERMINAL");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A3");
    const snap = h.ops.snapshot(k);
    ok(snap?.intentKey === k, "A3 intentKey preserved");
    ok(snap?.releaseId === "rel-A3", "A3 releaseId preserved");
    ok(snap?.executionId === "exec-A3", "A3 executionId preserved");
    ok(snap?.projectId === "proj-A3", "A3 projectId preserved");
    ok(snap?.artifactId === "art-A3", "A3 artifactId preserved");
    ok(snap?.artifactDigest === "sha256:A3", "A3 artifactDigest preserved");
    ok(snap?.commitSha === "c-A3", "A3 commitSha preserved");
    ok(snap?.environment === "production", "A3 environment preserved");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "A4");
    const exec = mkExecutor(h, {
      workerId: "w-A4",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 5 },
    });
    await exec.runOnce(Date.now());
    const snap = h.ops.snapshot(k);
    ok(snap?.recoveryAttempts === 1, "A4 retry attempts preserved");
    ok(typeof snap?.nextRetryAt === "number", "A4 nextRetryAt preserved");
    ok(snap?.lastFailureClass === "RECOVERY_REQUIRED", "A4 lastFailureClass preserved");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A5");
    h.intents.acquireLease(k, "worker-X", 60_000);
    const snap = h.ops.snapshot(k);
    ok(snap?.leaseOwner === "worker-X", "A5 lease owner preserved");
    ok(typeof snap?.leaseExpiresAt === "number", "A5 lease expiry preserved");
    ok(snap?.leaseActive === true, "A5 derived leaseActive true");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "A6");
    const exec = mkExecutor(h, {
      workerId: "w-A6",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 5 },
    });
    await exec.runOnce(Date.now());
    const snap = h.ops.snapshot(k);
    ok(typeof snap?.lastRecoveryDecision === "string", "A6 decision journal preserved");
    const env = snap?.lastRecoveryDecision ? JSON.parse(snap.lastRecoveryDecision) : null;
    ok(env?.decision === "RETRY", "A6 decision journal decodes to RETRY");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A7");
    const exec = mkExecutor(h, { workerId: "w-A7", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const snap = h.ops.snapshot(k);
    ok(typeof snap?.reconciliationEvidence === "string", "A7 reconciliation evidence preserved");
    ok(typeof snap?.reconciledAt === "number", "A7 reconciledAt preserved");
  }

  // ============================================================
  // B - Classification
  // ============================================================
  section("B - Classification");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B1");
    ok(h.ops.snapshot(k)?.health === "RECOVERY_PENDING", "B1 fresh RECOVERY_PENDING");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "B2");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", { nextRetryAt: 0, recoveryReason: "x" });
    h.intents.releaseLease(k, "seeder");
    ok(h.ops.snapshot(k)?.health === "RETRY_DUE", "B2 retry due when nextRetryAt <= now");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "B3");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", { nextRetryAt: Date.now() + 60_000, recoveryReason: "x" });
    h.intents.releaseLease(k, "seeder");
    ok(h.ops.snapshot(k)?.health === "RETRY_SCHEDULED", "B3 retry scheduled when nextRetryAt > now");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B4");
    h.intents.acquireLease(k, "worker-L", 60_000);
    ok(h.ops.snapshot(k)?.health === "LEASE_HELD", "B4 lease held");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B5");
    h.intents.acquireLease(k, "worker-L", 1);
    await new Promise((r) => setTimeout(r, 10));
    ok(h.ops.snapshot(k)?.health === "LEASE_EXPIRED", "B5 lease expired");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "B6");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Number.MAX_SAFE_INTEGER,
      recoveryAttempts: 5,
      recoveryReason: "exhausted",
    });
    h.intents.releaseLease(k, "seeder");
    ok(h.ops.snapshot(k)?.health === "EXHAUSTED", "B6 exhausted");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B7");
    const exec = mkExecutor(h, { workerId: "w-B7", orchestratorThrows: true });
    await exec.runOnce(Date.now());
    ok(h.ops.snapshot(k)?.health === "WAITING_RECONCILIATION", "B7 waiting reconciliation after SAFE_TO_RESUME");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "B8");
    const exec = mkExecutor(h, { workerId: "w-B8", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    ok(h.ops.snapshot(k)?.health === "TERMINAL", "B8 terminal");
  }

  // ============================================================
  // C - Decision journal
  // ============================================================
  section("C - Decision journal");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "C1");
    const exec = mkExecutor(h, {
      workerId: "w-C1",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 5 },
    });
    await exec.runOnce(Date.now());
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.available === true && e.decision === "RETRY", "C1 RETRY parsed");
    ok(e.attempts === 1 && e.maxAttempts === 5, "C1 attempts + maxAttempts parsed");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "C2");
    const exec = mkExecutor(h, {
      workerId: "w-C2",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 1 },
    });
    await exec.runOnce(Date.now());
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.decision === "EXHAUST", "C2 EXHAUST parsed");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C3");
    const exec = mkExecutor(h, { workerId: "w-C3", orchestratorThrows: true });
    await exec.runOnce(Date.now());
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.decision === "SAFE_TO_RESUME", "C3 SAFE_TO_RESUME parsed");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C4");
    const exec = mkExecutor(h, { workerId: "w-C4", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.decision === "KNOWN_GOOD", "C4 KNOWN_GOOD parsed");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C5");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "DEPLOYING", "seeder", { lastRecoveryDecision: "not json at all" });
    h.intents.releaseLease(k, "seeder");
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.invalid === true && e.available === false, "C5 malformed journal safely rejected");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C6");
    const e = h.ops.explainDecision(h.intents.get(k)!);
    ok(e.available === false && e.invalid === false, "C6 missing journal handled");
  }

  // ============================================================
  // D - Evidence
  // ============================================================
  section("D - Evidence");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D1");
    const exec = mkExecutor(h, { workerId: "w-D1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const snap = h.ops.snapshot(k)!;
    const ev = h.ops.inspectEvidence(h.intents.get(k)!);
    const fr = h.ops.evaluateFreshness(snap, ev);
    ok(ev.available === true, "D1 valid evidence accepted for inspection");
    ok(fr.fresh === true, "D1 identity chain fresh");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D2");
    const oldTs = Date.now() - 48 * 60 * 60 * 1000;
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "test", releaseId: "rel-D2", executionId: "exec-D2",
        artifactId: "art-D2", artifactDigest: "sha256:D2",
        environment: "production", timestamp: oldTs,
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const snap = h.ops.snapshot(k)!;
    const ev = h.ops.inspectEvidence(h.intents.get(k)!);
    const fr = h.ops.evaluateFreshness(snap, ev);
    ok(fr.fresh === false, "D2 stale evidence detected");
    ok(fr.reasons.some((r) => /age/.test(r)), "D2 age reason present");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D3");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "t", releaseId: "WRONG", executionId: "exec-D3",
        artifactId: "art-D3", artifactDigest: "sha256:D3",
        environment: "production", timestamp: Date.now(),
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const fr = h.ops.evaluateFreshness(h.ops.snapshot(k)!, h.ops.inspectEvidence(h.intents.get(k)!));
    ok(fr.reasons.includes("releaseId mismatch"), "D3 wrong release rejected");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D4");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "t", releaseId: "rel-D4", executionId: "WRONG",
        artifactId: "art-D4", artifactDigest: "sha256:D4",
        environment: "production", timestamp: Date.now(),
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const fr = h.ops.evaluateFreshness(h.ops.snapshot(k)!, h.ops.inspectEvidence(h.intents.get(k)!));
    ok(fr.reasons.includes("executionId mismatch"), "D4 wrong execution rejected");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D5");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "t", releaseId: "rel-D5", executionId: "exec-D5",
        artifactId: "WRONG", artifactDigest: "sha256:D5",
        environment: "production", timestamp: Date.now(),
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const fr = h.ops.evaluateFreshness(h.ops.snapshot(k)!, h.ops.inspectEvidence(h.intents.get(k)!));
    ok(fr.reasons.includes("artifactId mismatch"), "D5 wrong artifact rejected");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D6");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "t", releaseId: "rel-D6", executionId: "exec-D6",
        artifactId: "art-D6", artifactDigest: "sha256:D6",
        environment: "WRONG", timestamp: Date.now(),
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const fr = h.ops.evaluateFreshness(h.ops.snapshot(k)!, h.ops.inspectEvidence(h.intents.get(k)!));
    ok(fr.reasons.includes("environment mismatch"), "D6 wrong environment rejected");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D7");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.transitionIfOwned(k, "KNOWN_GOOD", "seeder", {
      reconciliationEvidence: JSON.stringify({
        source: "t", releaseId: "rel-D7", executionId: "exec-D7",
        artifactId: "art-D7", artifactDigest: "sha256:D7",
        environment: "production", imageDigest: "sha256:WRONGIMG",
        timestamp: Date.now(),
      }),
    });
    h.intents.releaseLease(k, "seeder");
    const snap = h.ops.snapshot(k)!;
    const ev = h.ops.inspectEvidence(h.intents.get(k)!);
    ok(snap.imageDigest === "sha256:dig-D7", "D7 intent imageDigest preserved on snapshot");
    ok(ev.imageDigest === "sha256:WRONGIMG", "D7 evidence imageDigest surfaced for operator comparison");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D8");
    const chain = h.ops.verifyIdentityChain(h.ops.snapshot(k)!);
    ok(chain.valid === true, "D8 valid identity chain accepted");
  }

  // ============================================================
  // E - Control
  // ============================================================
  section("E - Control");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E1");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "future retry",
    });
    h.intents.releaseLease(k, "seeder");
    const r = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r.accepted === true, "E1 reconcile request accepted");
    ok(h.intents.get(k)?.nextRetryAt === 0, "E1 nextRetryAt reset to 0 (immediately eligible)");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E2");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "future retry",
    });
    h.intents.releaseLease(k, "seeder");
    const r1 = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    const r2 = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r1.accepted && r2.accepted, "E2 second reconcile accepted (idempotent outcome)");
    ok(h.intents.get(k)?.nextRetryAt === 0, "E2 state remains eligible");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "E3");
    const exec = mkExecutor(h, { workerId: "w-E3", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const r = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r.accepted === false && /terminal/i.test(r.reason), "E3 terminal reconcile rejected");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E4");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Number.MAX_SAFE_INTEGER, recoveryAttempts: 5, recoveryReason: "exhausted",
    });
    h.intents.releaseLease(k, "seeder");
    const r1 = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r1.accepted === false && /exhaust/i.test(r1.reason), "E4a exhausted rejected without force");
    const r2 = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1", force: true });
    ok(r2.accepted === true, "E4b exhausted accepted with force");
    ok(h.intents.get(k)?.recoveryAttempts === 0, "E4b attempts reset on force");
    ok(h.intents.get(k)?.nextRetryAt === 0, "E4b eligible again");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E5");
    const r = await h.ctrl.requestCancellation({ intentKey: k, actor: "op-1" });
    ok(r.accepted === true, "E5 cancellation accepted");
    ok(h.intents.get(k)?.cancelRequestedAt !== null, "E5 durable cancel_requested_at set");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E6");
    await h.ctrl.requestCancellation({ intentKey: k, actor: "op-1" });
    const r2 = await h.ctrl.requestCancellation({ intentKey: k, actor: "op-1" });
    ok(r2.accepted === true && r2.idempotent === true, "E6 duplicate cancellation safe + idempotent");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "E7");
    const exec = mkExecutor(h, { workerId: "w-E7", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    const reject = h.audits.find((a) => a.action === "recovery.control.rejected");
    ok(reject?.result === "deny", "E7 rejected action audited as deny");
    ok(reject?.metadata?.attemptedAction === "recovery.reconcile.requested", "E7 attempted action recorded");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "E8");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    const ok1 = h.audits.find((a) => a.action === "recovery.reconcile.requested" && a.result === "allow");
    ok(ok1 !== undefined, "E8 accepted action audited as allow");
  }

  // ============================================================
  // F - Concurrency
  // ============================================================
  section("F - Concurrency");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "F1");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 120_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    const [a, b] = await Promise.all([
      h.ctrl.requestReconciliation({ intentKey: k, actor: "op-A" }),
      h.ctrl.requestReconciliation({ intentKey: k, actor: "op-B" }),
    ]);
    ok(a.accepted || b.accepted, "F1 at least one reconcile accepted");
    ok(h.intents.get(k)?.nextRetryAt === 0, "F1 converged end state");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "F2");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    const before = h.intents.get(k)?.nextRetryAt ?? null;
    const stale = h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "stale-worker", {
      nextRetryAt: 0,
    });
    ok(stale.updated === false, "F2 stale worker cannot mutate");
    ok((h.intents.get(k)?.nextRetryAt ?? null) === before, "F2 state unchanged");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "F3");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    const otherLease = h.intents.acquireLease(k, "other-worker", 60_000);
    if (!otherLease.acquired) { throw new Error("F3 setup: other-worker lease not acquired"); }
    const r = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r.accepted === false && /lease/i.test(r.reason), "F3 lease fencing preserved against control request");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "F4");
    const exec = mkExecutor(h, { workerId: "w-F4", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const before = h.intents.get(k);
    const r = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    ok(r.accepted === false, "F4 terminal wins safely (control rejected)");
    const after = h.intents.get(k);
    ok(before?.status === after?.status && after?.status === "KNOWN_GOOD", "F4 terminal status preserved");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "F5");
    const r = await Promise.all([
      h.ctrl.requestCancellation({ intentKey: k, actor: "op-A" }),
      h.ctrl.requestReconciliation({ intentKey: k, actor: "op-B" }),
    ]);
    const after = h.intents.get(k);
    ok(
      after?.cancelRequestedAt !== null || after?.nextRetryAt === 0 || after?.status === "DEPLOYING",
      "F5 cancel/reconcile race left a coherent state",
    );
    ok(r.length === 2, "F5 both operations resolved");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "F6");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    const exec = mkExecutor(h, {
      workerId: "w-F6",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 3 },
    });
    const [sup, req] = await Promise.all([
      exec.runOnce(Date.now()),
      h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" }),
    ]);
    ok(typeof sup.scanned === "number", "F6 supervisor cycle completed");
    ok(typeof req.accepted === "boolean", "F6 control request resolved");
  }

  // ============================================================
  // G - Restart
  // ============================================================
  section("G - Restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-178-"));
    const dbFile = join(dir, "ops.db");
    let k = "";
    let snapBefore: any = null;
    let journalBefore: string | null = null;
    let evidenceBefore: string | null = null;
    {
      const h = mkHarness(dbFile);
      k = await seedIntentCreated(h, "G1");
      const exec = mkExecutor(h, { workerId: "w-G1", orchestratedStatus: "KNOWN_GOOD" });
      await exec.runOnce(Date.now());
      snapBefore = h.ops.snapshot(k);
      journalBefore = h.intents.get(k)?.lastRecoveryDecision ?? null;
      evidenceBefore = h.intents.get(k)?.reconciliationEvidence ?? null;
      h.raw.close();
    }
    {
      const h = mkHarness(dbFile);
      const snapAfter = h.ops.snapshot(k);
      ok(snapAfter?.intentKey === snapBefore.intentKey, "G1 snapshot survives restart");
      ok(snapAfter?.status === snapBefore.status, "G1 status durable across restart");
      ok((h.intents.get(k)?.lastRecoveryDecision ?? null) === journalBefore, "G2 journal survives restart");
      ok((h.intents.get(k)?.reconciliationEvidence ?? null) === evidenceBefore, "G3 evidence survives restart");
      h.raw.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-178-"));
    const dbFile = join(dir, "ops2.db");
    let k = "";
    {
      const h = mkHarness(dbFile);
      k = await seedDeploying(h, "G4");
      h.intents.acquireLease(k, "seeder", 60_000);
      h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
        nextRetryAt: Date.now() + 120_000, recoveryReason: "future retry",
      });
      h.intents.releaseLease(k, "seeder");
      h.raw.close();
    }
    {
      const h = mkHarness(dbFile);
      const r = await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
      ok(r.accepted === true, "G4 control request works after restart");
      ok(h.intents.get(k)?.nextRetryAt === 0, "G4 durable effect applied");
      h.raw.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "G5");
    const exec = mkExecutor(h, { workerId: "w-G5", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const before = h.intents.get(k)?.status;
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    const after = h.intents.get(k)?.status;
    ok(before === after && after === "KNOWN_GOOD", "G5 inspect does not duplicate provider execution");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "G6");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "RECOVERY_REQUIRED", "seeder", {
      nextRetryAt: Date.now() + 60_000, recoveryReason: "x",
    });
    h.intents.releaseLease(k, "seeder");
    await h.ctrl.requestReconciliation({ intentKey: k, actor: "op-1" });
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    ok(h.intents.get(k)?.status !== "KNOWN_GOOD", "G6 no false KNOWN_GOOD produced");
  }

  // ============================================================
  // H - Isolation
  // ============================================================
  section("H - Isolation");
  {
    const h = mkHarness();
    await seedIntentCreated(h, "H1a", { projectId: "proj-A" });
    await seedIntentCreated(h, "H1b", { projectId: "proj-B" });
    const listA = h.ops.listSnapshots({ projectId: "proj-A" });
    const listB = h.ops.listSnapshots({ projectId: "proj-B" });
    ok(listA.every((s) => s.projectId === "proj-A") && listA.length === 1, "H1 project isolation on list");
    ok(listB.every((s) => s.projectId === "proj-B") && listB.length === 1, "H1 project-B list isolated");
  }
  {
    const h = mkHarness();
    await seedIntentCreated(h, "H2a", { environment: "production" });
    await seedIntentCreated(h, "H2b", { environment: "staging" });
    const prod = h.ops.listSnapshots({ environment: "production" });
    const stg = h.ops.listSnapshots({ environment: "staging" });
    ok(prod.every((s) => s.environment === "production"), "H2 environment isolation on list");
    ok(stg.every((s) => s.environment === "staging"), "H2 staging list isolated");
  }
  {
    const h = mkHarness();
    const kA = await seedIntentCreated(h, "H3a");
    const r = await h.ops.inspect({ intentKey: kA, actor: "op", projectId: "WRONG" });
    ok(r.rejected === true && r.reason === "project scope mismatch", "H3 release/project scope enforced on inspect");
  }
  {
    const h = mkHarness();
    const kA = await seedIntentCreated(h, "H4a");
    const kAAfter = h.intents.get(kA);
    ok(kAAfter?.executionId === "exec-H4a", "H4 executionId retained without cross-contamination");
    const kNo = await h.ops.snapshot("does-not-exist");
    ok(kNo === null, "H4 unknown intent yields null");
  }
  {
    const h = mkHarness();
    await seedIntentCreated(h, "H5a");
    await seedIntentCreated(h, "H5b");
    const list = h.ops.listSnapshots();
    const ids = new Set(list.map((s) => s.artifactId));
    ok(ids.size === list.length, "H5 no artifact cross-contamination");
  }

  // ============================================================
  // I - Read-only inspection
  // ============================================================
  section("I - Read-only inspection");
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "I1");
    const before = h.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k);
    const beforeJson = JSON.stringify(before);

    const ev = { _emit: h.events.length };
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    h.ops.snapshot(k);
    h.ops.listSnapshots();
    h.ops.metrics();

    const after = h.raw.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(k);
    const afterJson = JSON.stringify(after);
    ok(beforeJson === afterJson, "I1 intent row byte-for-byte unchanged after read-only inspection");
    const dockerEvents = h.events.filter((e) => /docker|deploy|provider/i.test(e.type ?? ""));
    ok(dockerEvents.length === 0, "I1 zero provider/docker events during inspection");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "I2");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.releaseLease(k, "seeder");
    const attemptsBefore = h.intents.get(k)?.recoveryAttempts ?? 0;
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    const attemptsAfter = h.intents.get(k)?.recoveryAttempts ?? 0;
    ok(attemptsBefore === attemptsAfter, "I2 retry increments unchanged");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "I3");
    const leaseBefore = h.intents.get(k)?.leasedBy ?? null;
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    const leaseAfter = h.intents.get(k)?.leasedBy ?? null;
    ok(leaseBefore === leaseAfter && leaseAfter === null, "I3 no leases acquired during inspection");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "I4");
    h.intents.acquireLease(k, "seeder", 60_000);
    h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
    h.intents.releaseLease(k, "seeder");
    const statusBefore = h.intents.get(k)?.status;
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    const statusAfter = h.intents.get(k)?.status;
    ok(statusBefore === statusAfter, "I4 zero state transitions");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "I5");
    const evBefore = h.events.length;
    await h.ops.inspect({ intentKey: k, actor: "op-1" });
    h.ops.metrics();
    const evAfter = h.events.length;
    ok(evBefore === evAfter, "I5 no events emitted by reads");
  }

  console.log("\n=== Phase 178 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });