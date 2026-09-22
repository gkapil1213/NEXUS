// scripts/test-phase177-durable-recovery-control-loop.ts
//
// Phase 177 - durable recovery decision journal.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real ReleaseRecoveryExecutor. Same harness shape as Phase 176.

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
import {
  buildRecoveryDecisionEnvelope,
  parseRecoveryDecision,
  serializeRecoveryDecision,
} from "../src/core/release-recovery-decision";

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
}

function mkHarness(file?: string): H {
  const raw = file ? new Database(file) : new Database(":memory:");
  new MigrationRunner(raw, join(process.cwd(), "src", "db", "migrations")).run();
  raw.exec(
    "CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));",
  );
  const engine = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(raw);
  const intents = new ReleaseDeploymentIntentService(store);
  return { raw, engine, store, intents, events: [], audits: [] };
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

function decision(intent: any): any {
  if (!intent?.lastRecoveryDecision) return null;
  try { return JSON.parse(intent.lastRecoveryDecision); } catch { return null; }
}

async function main() {
  // ============================================================
  // A. Seven decision kinds
  // ============================================================
  section("A - Decision journal: seven decision kinds");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A1");
    const exec = mkExecutor(h, { workerId: "w-A1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "KNOWN_GOOD", "RD177-01 KNOWN_GOOD decision recorded");
    ok(d?.action === "RESUME_FROM_INTENT", "RD177-01 action is the classifier action");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A2");
    const exec = mkExecutor(h, { workerId: "w-A2", orchestratedStatus: "FAILED" });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "FAILED", "RD177-02 FAILED decision recorded");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A3");
    const exec = mkExecutor(h, { workerId: "w-A3", orchestratedStatus: "BLOCKED" });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "BLOCKED", "RD177-03 BLOCKED decision recorded");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "A4");
    const exec = mkExecutor(h, { workerId: "w-A4", orchestratorThrows: true });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    const d = decision(fresh);
    ok(d?.decision === "SAFE_TO_RESUME", "RD177-04 SAFE_TO_RESUME decision durable before outcome");
    ok(fresh?.status === "DEPLOYING", "RD177-04 intent left at crash-safe DEPLOYING point");
    ok(d?.action === "RESUME_FROM_INTENT", "RD177-04 envelope records classifying action");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "A5");
    const exec = mkExecutor(h, {
      workerId: "w-A5",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 3 },
    });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "RETRY", "RD177-05 RETRY decision recorded when attempts remain");
    ok(typeof d?.nextRetryAt === "number" && d.nextRetryAt > Date.now(), "RD177-05 nextRetryAt is in the future");
    ok(d?.maxAttempts === 3, "RD177-05 maxAttempts carried in envelope");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "A6");
    const exec = mkExecutor(h, {
      workerId: "w-A6",
      retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 1 },
    });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "EXHAUST", "RD177-06 EXHAUST decision recorded when maxAttempts reached");
    ok(d?.nextRetryAt === Number.MAX_SAFE_INTEGER, "RD177-06 exhaustion sentinel carried in envelope");
  }
  {
    const h = mkHarness();
    const k = await seedDeploying(h, "A7");
    const exec = mkExecutor(h, { workerId: "w-A7" });
    await exec.runOnce(Date.now());
    const d = decision(h.intents.get(k));
    ok(d?.decision === "REMAIN_RECOVERY_REQUIRED", "RD177-07 REMAIN_RECOVERY_REQUIRED when no retryPolicy configured");
    ok(d?.nextRetryAt === null, "RD177-07 nextRetryAt null without retryPolicy");
  }

  // ============================================================
  // B. Restart durability
  // ============================================================
  section("B - Restart durability");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-177-"));
    const dbFile = join(dir, "recovery.db");
    let k = "";
    let originalDecisionJson: string | null = null;
    {
      const h = mkHarness(dbFile);
      k = await seedDeploying(h, "B1");
      const exec = mkExecutor(h, {
        workerId: "w-B1",
        retryPolicy: { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60_000, maxAttempts: 1 },
      });
      await exec.runOnce(Date.now());
      originalDecisionJson = h.intents.get(k)?.lastRecoveryDecision ?? null;
      h.raw.close();
    }
    {
      const h2 = mkHarness(dbFile);
      const fresh = h2.intents.get(k);
      ok(fresh?.lastRecoveryDecision === originalDecisionJson, "RD177-10 decision journal survives restart byte-for-byte");
      const d = decision(fresh);
      ok(d?.decision === "EXHAUST", "RD177-11 EXHAUST readable after restart without sentinel arithmetic");
      ok(d?.attempts === 1, "RD177-11 attempts count durable across restart");
      h2.raw.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // C. SAFE_TO_RESUME crash safety
  // ============================================================
  section("C - SAFE_TO_RESUME crash safety");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "C1");
    const exec = mkExecutor(h, { workerId: "w-C1", orchestratorThrows: true });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    const d = decision(fresh);
    ok(d?.decision === "SAFE_TO_RESUME", "RD177-13 SAFE_TO_RESUME written before provider outcome");
    ok(fresh?.status === "DEPLOYING", "RD177-13 intent left DEPLOYING after provider crash");
    ok((h.events.filter((e) => e.type === "release.recovery.known_good")).length === 0, "RD177-13 no false success event");
  }

  // ============================================================
  // D. Idempotency and fencing
  // ============================================================
  section("D - Idempotency and fencing");
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D1");
    const exec = mkExecutor(h, { workerId: "w-D1", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const d1 = h.intents.get(k)?.lastRecoveryDecision ?? null;
    await exec.runOnce(Date.now());
    const d2 = h.intents.get(k)?.lastRecoveryDecision ?? null;
    ok(d1 !== null && d1 === d2, "RD177-14 terminal KNOWN_GOOD: decision unchanged on replay");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D2");
    const exec = mkExecutor(h, { workerId: "w-D2", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const before = h.intents.get(k)?.lastRecoveryDecision ?? null;
    const stale = h.intents.transitionIfOwned(k, "FAILED", "w-D2-stale", {
      lastRecoveryDecision: JSON.stringify({ forged: true, decision: "FAILED" }),
      lastRecoveryDecisionAt: Date.now(),
    });
    ok(stale.updated === false, "RD177-15 stale worker cannot write decision (fencing preserved)");
    ok((h.intents.get(k)?.lastRecoveryDecision ?? null) === before, "RD177-15 decision unchanged after stale attempt");
  }
  {
    const h = mkHarness();
    const k = await seedIntentCreated(h, "D3");
    const exec = mkExecutor(h, { workerId: "w-D3", orchestratedStatus: "KNOWN_GOOD" });
    await exec.runOnce(Date.now());
    const t1 = h.intents.get(k)?.lastRecoveryDecisionAt ?? 0;
    ok(typeof t1 === "number" && t1 > 0, "RD177-16 decision timestamp persisted");
  }

  // ============================================================
  // E. Envelope bounds and parsing
  // ============================================================
  section("E - Envelope bounds and parsing");
  {
    const long = "x".repeat(2000);
    const env = buildRecoveryDecisionEnvelope({
      decision: "RETRY", action: "RECOVERY_REQUIRED", reason: long,
      workerId: "w", intentKey: "k",
    });
    ok(env.reason.length <= 500, "RD177-17 envelope truncates reason at 500 chars");
    ok(env.reason.endsWith("...[trunc]"), "RD177-17 truncation marker present");
  }
  {
    const env = buildRecoveryDecisionEnvelope({
      decision: "KNOWN_GOOD", action: "RESUME_FROM_INTENT", reason: "ok",
      workerId: "w", intentKey: "k",
    });
    const json = serializeRecoveryDecision(env);
    ok(json.length > 0 && json.length <= 4096, "RD177-18 serialized envelope is bounded");
    const parsed = parseRecoveryDecision(json);
    ok(parsed?.decision === "KNOWN_GOOD", "RD177-18 round-trip preserves decision");
    ok(parsed?.intentKey === "k", "RD177-18 round-trip preserves intentKey");
  }
  {
    ok(parseRecoveryDecision(null) === null, "RD177-19 null parsed as no decision");
    ok(parseRecoveryDecision("not json") === null, "RD177-19 garbage parsed as no decision");
    ok(parseRecoveryDecision('{"decision":"X"}') === null, "RD177-19 missing intentKey rejected");
  }

  console.log("\n=== Phase 177 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });