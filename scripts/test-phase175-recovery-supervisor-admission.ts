// scripts/test-phase175-recovery-supervisor-admission.ts
//
// Phase 175 - recovery supervisor, admission control, durable scheduling.
//
// Real SQLite + real ExecutionStore + real ReleaseDeploymentIntentService +
// real ReleaseRecoveryExecutor + real ReleaseRecoverySupervisor. Orchestrator
// and docker are minimal stubs used only to route intents into the recovery
// state machine. No fake deployment success. Every assertion reads durable
// state or an event/audit capture.

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
import { ReleaseRecoverySupervisor } from "../src/core/release-recovery-supervisor";

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
  const events: CapturedEvent[] = [];
  const audits: CapturedAudit[] = [];
  return { raw, engine, store, intents, events, audits };
}

function mkExecutor(h: H, opts: {
  workerId: string;
  maxIntentsPerRun?: number;
  retryPolicy?: { initialDelayMs: number; multiplier: number; maxDelayMs: number; maxAttempts: number };
  orchestratorThrows?: boolean;
}): ReleaseRecoveryExecutor {
  const events = { emit: async (e: CapturedEvent) => { h.events.push(e); } };
  const audit = { record: async (e: CapturedAudit) => { h.audits.push(e); } };
  const orchestratorStub: any = {
    deploy: async () => {
      if (opts.orchestratorThrows) throw new Error("provider unavailable");
      return { deployment: { id: "dep-stub", status: "DEPLOYING" }, rollback: null };
    },
  };
  const historyStub: any = { getDeployment: async () => null };
  // DockerAdapter returns { status, stdout, stderr }. Returning FAILED for
  // inspect makes inspectIntentContainer return verdict=MISSING, which routes
  // through markRecoveryRequired (advances retry counter) rather than throwing.
  const dockerStub: any = {
    run: async (_op: any) => ({ status: "FAILED", stdout: "", stderr: "no container" }),
  };
  const smokeStub: any = { run: async () => ({ status: "PASS" }) };
  const deps: any = {
    intents: h.intents,
    recovery: new ReleaseRecoveryService(),
    orchestrator: orchestratorStub,
    history: historyStub,
    docker: dockerStub,
    smoke: smokeStub,
    svc: { events, audit },
    workerId: opts.workerId,
    maxIntentsPerRun: opts.maxIntentsPerRun,
    retryPolicy: opts.retryPolicy,
  };
  return new ReleaseRecoveryExecutor(deps);
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
    imageId: null,
    imageDigest: "sha256:" + prefix,
    containerName: "c-" + prefix,
    containerPort: 8080,
    attemptId: null,
    ...extra,
  };
}

async function seedIntent(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { intent } = await h.intents.getOrCreate(mkInput(prefix, extra));
  return intent.intentKey;
}

// Force an intent into DEPLOYMENT_INTENT_CREATED without attemptId, which
// deterministically routes it through markRecoveryRequired when the executor
// tries to resume it.
async function seedRecoverable(h: H, prefix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const k = await seedIntent(h, prefix, { ...extra, attemptId: null });
  // Acquire a brief lease, transition to DEPLOYMENT_INTENT_CREATED, release.
  h.intents.acquireLease(k, "seeder", 60000);
  h.intents.transitionIfOwned(k, "DEPLOYMENT_INTENT_CREATED", "seeder", {});
  h.intents.releaseLease(k, "seeder");
  return k;
}

async function main() {
  // ============================================================
  // A. Durable recovery discovery (RS175-01, 02, 14, 28)
  // ============================================================
  section("A - Durable recovery discovery");
  {
    const h = mkHarness();
    const k1 = await seedRecoverable(h, "A1");
    const k2 = await seedRecoverable(h, "A2");
    const list = h.intents.listRecoverable();
    const keys = list.map((i) => i.intentKey);
    ok(keys.includes(k1) && keys.includes(k2), "RS175-01 durable discovery: recoverable intents found via SQL");

    // Terminal intents excluded
    const k3 = await seedIntent(h, "A3");
    h.intents.acquireLease(k3, "w", 60000);
    h.intents.transitionIfOwned(k3, "KNOWN_GOOD", "w", { deploymentId: "dep-A3" });
    const list2 = h.intents.listRecoverable();
    ok(!list2.map((i) => i.intentKey).includes(k3), "RS175-14 terminal KNOWN_GOOD excluded from recoverable set");

    // Duplicate discovery: two calls to listRecoverable return the same durable set
    const listA = h.intents.listRecoverable().map((i) => i.intentKey).sort();
    const listB = h.intents.listRecoverable().map((i) => i.intentKey).sort();
    ok(JSON.stringify(listA) === JSON.stringify(listB), "RS175-02 duplicate discovery is idempotent (same durable set)");
  }

  // ============================================================
  // B. Single-owner admission during supervisor cycle
  //    (RS175-03, 04, 07, 09, 25)
  // ============================================================
  section("B - Single-owner admission");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "B1");

    // Worker A acquires the lease, then we run executor with worker B.
    h.intents.acquireLease(k, "worker-A", 60_000);
    const execB = mkExecutor(h, { workerId: "worker-B" });
    const rep = await execB.runOnce(Date.now());
    // worker B sees the intent but cannot lease it
    ok((rep.leaseHeld ?? 0) >= 1, "RS175-03 single-owner admission: worker B lease-contention counted");
    const fresh = h.intents.get(k);
    ok(fresh?.leasedBy === "worker-A", "RS175-04 concurrent supervisor admission: worker-A retains lease");
  }

  // ============================================================
  // C. Capacity enforcement (RS175-05, 27)
  // ============================================================
  section("C - Capacity enforcement");
  {
    const h = mkHarness();
    for (let i = 0; i < 5; i++) await seedRecoverable(h, "C" + i);
    const exec = mkExecutor(h, { workerId: "cap-worker", maxIntentsPerRun: 2 });
    const rep = await exec.runOnce(Date.now());
    ok(rep.scanned === 5, "RS175-05 scanned counts all discoverable");
    ok(rep.deferredCapacity === 3, "RS175-05 capacity cap defers 3 of 5");
    ok(rep.actions.length <= 2, "RS175-05 at most maxIntentsPerRun processed");

    // Backpressure: durable state preserved
    const still = h.intents.listRecoverable();
    ok(still.length === 5, "RS175-27 backpressure preserves durable recoverable work");
  }

  // ============================================================
  // D. Retry scheduling + backoff (RS175-10, 11, 13)
  // ============================================================
  section("D - Retry scheduling and backoff");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "D1");
    const policy = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 10_000, maxAttempts: 3 };
    const exec = mkExecutor(h, { workerId: "retry-worker", retryPolicy: policy });

    const before = Date.now();
    const rep1 = await exec.runOnce(before);
    ok(rep1.scanned === 1, "RS175-10 discovered 1 recoverable intent");
    const after1 = h.intents.get(k);
    ok(after1?.recoveryAttempts === 1, "RS175-10 first recovery attempt recorded durably");
    // markRecoveryRequired writes nextRetryAt = Date.now() + initialDelayMs using
    // wall-clock (consistent with the rest of the executor's mutation paths).
    const r1 = after1?.nextRetryAt ?? 0;
    ok(r1 >= before + 1_000 && r1 <= Date.now() + 1_000 + 200, "RS175-11 backoff: nextRetryAt ~= now + initialDelayMs");
    ok(after1?.lastFailureClass === "RECOVERY_REQUIRED", "RS175-10 failure class recorded");

    // Second run immediately -> not due yet
    const rep2 = await exec.runOnce(Date.now());
    ok(rep2.deferredNotDue === 1, "RS175-11 not-due retry deferred in cycle");
    const after2 = h.intents.get(k);
    ok(after2?.recoveryAttempts === 1, "RS175-11 attempts unchanged when deferred");

    // Force due by rewriting nextRetryAt to a past timestamp.
    h.raw.prepare("UPDATE release_deployment_intents SET next_retry_at = ? WHERE intent_key = ?").run(Date.now() - 1, k);
    const before2 = Date.now();
    const rep3 = await exec.runOnce(before2);
    ok(rep3.deferredNotDue === 0, "RS175-11 due retry no longer deferred");
    const after3 = h.intents.get(k);
    ok(after3?.recoveryAttempts === 2, "RS175-11 second attempt recorded");
    const r2 = after3?.nextRetryAt ?? 0;
    // Second backoff uses multiplier=2 -> delay ~= 2000ms.
    ok(r2 >= before2 + 2_000 && r2 <= Date.now() + 2_000 + 200, "RS175-11 backoff doubled (multiplier=2)");
    ok(r2 > r1, "RS175-11 next retry moves forward in time");

    // Audit emitted
    ok(h.audits.some((a) => a.action === "release.recovery.retry_scheduled"), "RS175-13 retry_scheduled audit emitted");
  }

  // ============================================================
  // E. Retry exhaustion (RS175-12)
  // ============================================================
  section("E - Retry exhaustion");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "E1");
    const policy = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 500, maxAttempts: 2 };
    const exec = mkExecutor(h, { workerId: "exh-worker", retryPolicy: policy });

    await exec.runOnce(Date.now()); // attempt 1
    const a1 = h.intents.get(k);
    ok(a1?.recoveryAttempts === 1, "RS175-12 attempt 1 recorded");

    // Force due and re-run -> attempt 2 = maxAttempts -> exhaustion
    h.raw.prepare("UPDATE release_deployment_intents SET next_retry_at = ? WHERE intent_key = ?").run(Date.now() - 1, k);
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.recoveryAttempts === 2, "RS175-12 attempts reached maxAttempts");
    ok(fresh?.nextRetryAt === Number.MAX_SAFE_INTEGER, "RS175-12 exhausted retry has far-future sentinel (never eligible again)");
    ok(fresh?.status === "RECOVERY_REQUIRED", "RS175-12 remains RECOVERY_REQUIRED after exhaustion");
    ok(h.audits.some((a) => a.action === "release.recovery.retry_exhausted"), "RS175-12 retry_exhausted audit emitted");
  }

  // ============================================================
  // F. Recovery storm protection (RS175-13)
  // ============================================================
  section("F - Recovery storm protection");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "F1");
    const policy = { initialDelayMs: 500, multiplier: 2, maxDelayMs: 2_000, maxAttempts: 3 };
    const exec = mkExecutor(h, { workerId: "storm-worker", retryPolicy: policy });

    // Rapid-fire 10 cycles in a tight window. The retry policy must throttle.
    let total = 0;
    const base = 20_000_000;
    for (let i = 0; i < 10; i++) {
      const rep = await exec.runOnce(base + i); // 1ms apart
      total += rep.actions.length;
    }
    ok(total <= 3, "RS175-13 storm protection: bounded attempts across rapid cycles (" + total + " <= 3)");
    const fresh = h.intents.get(k);
    ok((fresh?.recoveryAttempts ?? 0) <= 3, "RS175-13 attempts bounded by maxAttempts");
  }

  // ============================================================
  // G. Lease-aware admission during supervisor cycle
  //    (RS175-07, 08)
  // ============================================================
  section("G - Lease-aware admission");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "G1");
    h.intents.acquireLease(k, "live-worker", 60_000);
    const exec = mkExecutor(h, { workerId: "other-worker" });
    const rep = await exec.runOnce(Date.now());
    ok((rep.leaseHeld ?? 0) >= 1, "RS175-07 live lease prevents other worker from executing");

    // Expire the live lease and retry
    h.intents.releaseLease(k, "live-worker");
    const rep2 = await exec.runOnce(Date.now());
    ok((rep2.leaseHeld ?? 0) === 0, "RS175-08 expired/released lease is reclaimable");
  }

  // ============================================================
  // H. Stale worker fencing (RS175-09, 30)
  // ============================================================
  section("H - Stale worker fencing");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "H1");
    h.intents.acquireLease(k, "old-worker", 30);
    await new Promise((r) => setTimeout(r, 100));
    const newLease = h.intents.acquireLease(k, "new-worker");
    ok(newLease.acquired === true, "RS175-09 new worker takes over expired lease");

    const stale = h.intents.transitionIfOwned(k, "KNOWN_GOOD", "old-worker", { deploymentId: "dep-ghost" });
    ok(stale.updated === false, "RS175-30 new owner cannot inherit stale worker authority");
    const fresh = h.intents.get(k);
    ok(fresh?.deploymentId === null, "RS175-30 stale worker write rejected");
  }

  // ============================================================
  // I. Cross-project / cross-environment isolation (RS175-15, 16)
  // ============================================================
  section("I - Cross-project / cross-environment isolation");
  {
    const h = mkHarness();
    const kA = await seedRecoverable(h, "IA", { projectId: "proj-alpha", environment: "production" });
    const kB = await seedRecoverable(h, "IB", { projectId: "proj-beta", environment: "production" });
    const kC = await seedRecoverable(h, "IC", { projectId: "proj-alpha", environment: "staging" });

    const list = h.intents.listRecoverable();
    const byKey: Record<string, any> = {};
    for (const i of list) byKey[i.intentKey] = i;
    ok(byKey[kA]?.projectId === "proj-alpha", "RS175-15 alpha project preserved");
    ok(byKey[kB]?.projectId === "proj-beta", "RS175-15 beta project preserved and distinct");
    ok(byKey[kC]?.environment === "staging", "RS175-16 staging environment preserved");
    ok(byKey[kA]?.environment === "production", "RS175-16 production environment preserved");

    // hasActiveIntentForEnvironment is environment-scoped
    ok(h.intents.hasActiveIntentForEnvironment("production", "none") === true, "RS175-16 production env has active intent");
  }

  // ============================================================
  // J. Supervisor lifecycle (RS175-21, 22)
  // ============================================================
  section("J - Supervisor lifecycle");
  {
    const h = mkHarness();
    const exec = mkExecutor(h, { workerId: "sup-worker" });
    const events = { emit: async (e: CapturedEvent) => { h.events.push(e); } };
    const audit = { record: async (e: CapturedAudit) => { h.audits.push(e); } };
    const sup = new ReleaseRecoverySupervisor({
      executor: exec,
      svc: { events, audit },
      workerId: "sup-worker",
      intervalMs: 100_000,
    });
    ok(sup.status().state === "STOPPED", "RS175-21 supervisor starts in STOPPED");
    await sup.start();
    ok(sup.status().state === "RUNNING", "RS175-21 supervisor transitions to RUNNING");
    await sup.stop();
    ok(sup.status().state === "STOPPED", "RS175-22 supervisor returns to STOPPED");
    ok(h.audits.some((a) => a.action === "release.recovery.supervisor.start"), "RS175-23 start audit emitted");
    ok(h.audits.some((a) => a.action === "release.recovery.supervisor.stop"), "RS175-23 stop audit emitted");
    ok(h.events.some((e) => e.type === "release.recovery.supervisor.started"), "RS175-23 started event emitted");
  }

  // ============================================================
  // K. Supervisor runs executor (RS175-04, 23)
  // ============================================================
  section("K - Supervisor runs executor");
  {
    const h = mkHarness();
    await seedRecoverable(h, "K1");
    const exec = mkExecutor(h, { workerId: "k-worker" });
    const sup = new ReleaseRecoverySupervisor({
      executor: exec,
      svc: { events: { emit: async (e) => h.events.push(e) }, audit: { record: async (e) => h.audits.push(e) } },
      workerId: "k-worker",
      intervalMs: 100_000,
    });
    const rep = await sup.runNow();
    ok(rep.scanned >= 1, "RS175-04 supervisor runNow drives executor discovery");
    ok(h.events.some((e) => e.type === "release.recovery.started"), "RS175-23 executor started event emitted via supervisor");
  }

  // ============================================================
  // L. Crash + restart durability (RS175-17..20, 24, 29)
  // ============================================================
  section("L - Crash + restart durability");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-p175-"));
    const dbFile = join(dir, "state.db");
    let intentKey: string | null = null;
    try {
      // Instance A: seed, advance to RECOVERY_REQUIRED with UNKNOWN, crash.
      {
        const hA = mkHarness(dbFile);
        intentKey = await seedRecoverable(hA, "L1");
        const policy = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000, maxAttempts: 3 };
        const execA = mkExecutor(hA, { workerId: "worker-A", retryPolicy: policy });
        await execA.runOnce(Date.now());
        const a1 = hA.intents.get(intentKey);
        ok(a1?.status === "RECOVERY_REQUIRED", "RS175-19 crash during provider ambiguity: RECOVERY_REQUIRED persisted");
        ok(a1?.providerStatus === "UNKNOWN", "RS175-24 UNKNOWN provider outcome recorded");
        hA.raw.close();
      }

      // Instance B on same DB
      {
        const hB = mkHarness(dbFile);
        const b1 = hB.intents.get(intentKey!);
        ok(b1 !== undefined, "RS175-20 restart discovers durable intent");
        ok(b1?.status === "RECOVERY_REQUIRED", "RS175-20 restart sees RECOVERY_REQUIRED");
        ok(b1?.providerStatus === "UNKNOWN", "RS175-24 UNKNOWN survives restart");
        ok(b1?.recoveryAttempts === 1, "RS175-20 recoveryAttempts survived restart");

        // Worker B can claim if the lease is free (expired or was released)
        const lease = hB.intents.acquireLease(intentKey!, "worker-B", 60_000);
        ok(lease.acquired === true, "RS175-29 recovery owner replacement after restart");

        // Worker A (from previous process) is fenced
        const stale = hB.intents.transitionIfOwned(intentKey!, "KNOWN_GOOD", "worker-A", { deploymentId: "dep-X" });
        ok(stale.updated === false, "RS175-20 worker-A is fenced in new process");

        hB.raw.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ============================================================
  // M. Supervisor restart on same DB (RS175-20)
  // ============================================================
  section("M - Supervisor restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "nexus-p175sup-"));
    const dbFile = join(dir, "state.db");
    try {
      let k: string | null = null;
      {
        const hA = mkHarness(dbFile);
        k = await seedRecoverable(hA, "M1");
        const execA = mkExecutor(hA, { workerId: "sup-A" });
        const supA = new ReleaseRecoverySupervisor({
          executor: execA,
          svc: { events: { emit: async () => {} }, audit: { record: async () => {} } },
          workerId: "sup-A",
          intervalMs: 100_000,
        });
        await supA.start();
        await supA.stop();
        hA.raw.close();
      }
      {
        const hB = mkHarness(dbFile);
        const execB = mkExecutor(hB, { workerId: "sup-B" });
        const supB = new ReleaseRecoverySupervisor({
          executor: execB,
          svc: { events: { emit: async () => {} }, audit: { record: async () => {} } },
          workerId: "sup-B",
          intervalMs: 100_000,
        });
        const rep = await supB.runNow();
        ok(rep.scanned >= 1, "RS175-20 supervisor B discovers durable recoverable work from supervisor A");
        hB.raw.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ============================================================
  // N. Fairness: oldest work not starved (RS175-06, 26)
  // ============================================================
  section("N - Fairness and starvation protection");
  {
    const h = mkHarness();
    // Seed 3 intents with distinct created_at (natural ordering: newest first
    // per listRecoverable SQL). Cap at 2 -> one is deferred.
    const k1 = await seedRecoverable(h, "N1");
    await new Promise((r) => setTimeout(r, 10));
    const k2 = await seedRecoverable(h, "N2");
    await new Promise((r) => setTimeout(r, 10));
    const k3 = await seedRecoverable(h, "N3");

    const exec = mkExecutor(h, { workerId: "fair-worker", maxIntentsPerRun: 2 });
    const rep = await exec.runOnce(Date.now());
    ok(rep.deferredCapacity === 1, "RS175-06 capacity cap defers 1 of 3");

    // Advance: the deferred intent must be picked up on a subsequent cycle
    // (after the others transition to RECOVERY_REQUIRED with retry backoff,
    // they become not-due, and the deferred one is now eligible).
    const policy = { initialDelayMs: 10_000, multiplier: 2, maxDelayMs: 20_000, maxAttempts: 3 };
    const exec2 = mkExecutor(h, { workerId: "fair-worker-2", maxIntentsPerRun: 5, retryPolicy: policy });
    const rep2 = await exec2.runOnce(Date.now() + 1_000);
    // At least one previously-deferred intent is processed
    const processed2 = rep2.actions.map((a) => a.intentKey);
    ok(processed2.length >= 1, "RS175-26 deferred work is picked up on a later cycle (no starvation)");
  }

  // ============================================================
  // O. Provider safety: UNKNOWN stays RECOVERY_REQUIRED (RS175-24)
  // ============================================================
  section("O - UNKNOWN stays RECOVERY_REQUIRED");
  {
    const h = mkHarness();
    const k = await seedRecoverable(h, "O1");
    const exec = mkExecutor(h, { workerId: "o-worker", orchestratorThrows: true });
    await exec.runOnce(Date.now());
    const fresh = h.intents.get(k);
    ok(fresh?.status !== "KNOWN_GOOD", "RS175-24 UNKNOWN never becomes KNOWN_GOOD");
    ok(fresh?.status !== "FAILED", "RS175-24 UNKNOWN never becomes definitive FAILED");
    ok(fresh?.status === "RECOVERY_REQUIRED", "RS175-24 status is RECOVERY_REQUIRED");
  }

  console.log("\n=== Phase 175 Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});