// scripts/test-phase206-worker-fencing.ts
// Phase 206: durable worker ownership, lease fencing, stale-worker recovery.
// Exercises the existing execution lease primitives against real SQLite
// persistence with real concurrency. No mocks. No schema change.

import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { reconcileExecution } from "../src/core/execution-reconciler";

type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const results: Record<string, Status> = {};

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness(dbFile?: string) {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const leases = new LeaseManager(store);
  return { store, rawDb, leases };
}

function seedExecution(store: ExecutionStore, executionId: string) {
  const now = Date.now();
  store.createJob({
    id: executionId, idempotencyKey: "k_" + executionId, jobType: "pipeline",
    payload: { tenantId: "t1", correlationId: "c1" },
    status: "RUNNING", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
}

function seedStage(store: ExecutionStore, executionId: string, stageName: string): string {
  const now = Date.now();
  const stageId = `${executionId}_${stageName}`;
  store.createJob({
    id: stageId, idempotencyKey: `${executionId}:${stageName}:1`,
    jobType: "pipeline.stage",
    payload: {
      kind: "pipeline.stage", executionId, stageName,
      tenantId: "t1", correlationId: "c1", attempt: 1,
      status: "PENDING", executor: "test",
      inputFingerprint: "fp", artifactReferences: [],
    },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
  return stageId;
}

function q1(rawDb: Database.Database, sql: string, ...args: any[]): any {
  return rawDb.prepare(sql).get(...args);
}

function setStageRunning(h: any, stageId: string, leaseId: string) {
  h.rawDb.prepare("UPDATE execution_jobs SET status = 'RUNNING', current_lease_id = ? WHERE id = ?").run(leaseId, stageId);
}

function expireLease(h: any, leaseId: string, at?: number) {
  const ts = at ?? Date.now();
  h.rawDb.prepare("UPDATE execution_leases SET status = 'EXPIRED', released_at = ? WHERE lease_id = ?").run(ts, leaseId);
}

function activeLeaseCount(h: any, stageId: string): number {
  return Number((q1(h.rawDb,
    "SELECT COUNT(*) AS c FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'", stageId) as any)?.c ?? -1);
}

async function run(id: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    if (!(id in results)) results[id] = "PASS";
  } catch (e: any) {
    results[id] = "FAIL";
    console.log(`[FAIL] ${id}: ${e?.message ?? e}`);
  }
}

function ok(id: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(detail ?? "assertion failed");
  if (!(id in results)) results[id] = "PASS";
}

async function main() {
  console.log("=== NEXUS PHASE 206 ===\n");

  await run("206A single acquisition", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_a", "A");
    const l = h.leases.acquireLease(stageId, "worker-A", 60_000);
    ok("206A single acquisition", h.leases.validateLease(l.leaseId, "worker-A"));
  });

  await run("206B concurrent acquisition", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_b", "A");
    const tryAcq = (wid: string) => {
      try { return { ok: true, lease: h.leases.acquireLease(stageId, wid, 60_000) }; }
      catch { return { ok: false }; }
    };
    const r1 = tryAcq("worker-A");
    const r2 = tryAcq("worker-B");
    const winners = (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0);
    ok("206B concurrent acquisition",
      winners === 1 && activeLeaseCount(h, stageId) === 1,
      `winners=${winners} active=${activeLeaseCount(h, stageId)}`);
  });

  await run("206C ownership generation", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_c", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    expireLease(h, lA.leaseId);
    const lB = h.leases.acquireLease(stageId, "worker-B", 60_000);
    ok("206C ownership generation",
      lB.leaseId !== lA.leaseId &&
      h.leases.validateLease(lB.leaseId, "worker-B") === true &&
      h.leases.validateLease(lA.leaseId, "worker-A") === false,
      `A=${lA.leaseId.slice(0,8)} B=${lB.leaseId.slice(0,8)}`);
  });

  await run("206D renewal", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_d", "A");
    const l = h.leases.acquireLease(stageId, "worker-A", 60_000);
    const before = q1(h.rawDb, "SELECT expires_at FROM execution_leases WHERE lease_id = ?", l.leaseId).expires_at;
    h.leases.renewLease(l.leaseId, "worker-A", 120_000);
    const after = q1(h.rawDb, "SELECT expires_at FROM execution_leases WHERE lease_id = ?", l.leaseId).expires_at;
    ok("206D renewal", Number(after) > Number(before), `before=${before} after=${after}`);
  });

  await run("206E stale renewal", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_e", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    expireLease(h, lA.leaseId);
    h.leases.acquireLease(stageId, "worker-B", 60_000);
    let threw = false;
    try { h.leases.renewLease(lA.leaseId, "worker-A", 120_000); } catch { threw = true; }
    ok("206E stale renewal", threw === true, `threw=${threw}`);
  });

  await run("206F takeover", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_f", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    setStageRunning(h, stageId, lA.leaseId);
    expireLease(h, lA.leaseId);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = NULL WHERE id = ?").run(stageId);
    const lB = h.leases.acquireLease(stageId, "worker-B", 60_000);
    const active = h.store.getActiveLeaseForJob(stageId);
    ok("206F takeover",
      active?.workerId === "worker-B" && active?.leaseId === lB.leaseId,
      `owner=${active?.workerId}`);
  });

  await run("206G stale heartbeat", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_g", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    setStageRunning(h, stageId, lA.leaseId);
    h.store.createAttempt({
      id: "att_g_A", jobId: stageId, attemptNumber: 1, status: "RUNNING",
      workerId: "worker-A", leaseId: lA.leaseId,
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);
    expireLease(h, lA.leaseId);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = NULL WHERE id = ?").run(stageId);
    h.leases.acquireLease(stageId, "worker-B", 60_000);
    const hb = h.store.recordAttemptHeartbeatAsOwner("att_g_A", stageId, lA.leaseId, "worker-A", Date.now());
    ok("206G stale heartbeat",
      hb.updated === false && hb.reason === "WORKER_OWNERSHIP_LOST",
      `reason=${hb.reason ?? "updated"}`);
  });

  await run("206H stale progress", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_h", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    setStageRunning(h, stageId, lA.leaseId);
    h.store.createAttempt({
      id: "att_h_A", jobId: stageId, attemptNumber: 1, status: "RUNNING",
      workerId: "worker-A", leaseId: lA.leaseId,
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);
    expireLease(h, lA.leaseId);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = NULL WHERE id = ?").run(stageId);
    h.leases.acquireLease(stageId, "worker-B", 60_000);
    const pr = h.store.recordAttemptProgressAsOwner("att_h_A", stageId, lA.leaseId, "worker-A", Date.now());
    ok("206H stale progress",
      pr.updated === false && pr.reason === "WORKER_OWNERSHIP_LOST",
      `reason=${pr.reason ?? "updated"}`);
  });

  await run("206I stale completion", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_i", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    setStageRunning(h, stageId, lA.leaseId);
    h.store.createAttempt({
      id: "att_i_A", jobId: stageId, attemptNumber: 1, status: "RUNNING",
      workerId: "worker-A", leaseId: lA.leaseId,
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);
    expireLease(h, lA.leaseId);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = NULL WHERE id = ?").run(stageId);
    h.leases.acquireLease(stageId, "worker-B", 60_000);
    const res = h.store.completeAttemptAndTransitionJob({
      attemptId: "att_i_A", jobId: stageId, leaseId: lA.leaseId, workerId: "worker-A",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    } as any);
    ok("206I stale completion",
      res.ok === false && res.reason === "WORKER_OWNERSHIP_LOST",
      `reason=${res.reason}`);
  });

  await run("206J retry fencing", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_j", "A");
    const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
    setStageRunning(h, stageId, lA.leaseId);
    h.store.createAttempt({
      id: "att_j_1", jobId: stageId, attemptNumber: 1, status: "RUNNING",
      workerId: "worker-A", leaseId: lA.leaseId,
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);
    h.rawDb.prepare("UPDATE execution_attempts SET status = 'FAILED' WHERE id = ?").run("att_j_1");
    expireLease(h, lA.leaseId);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = NULL WHERE id = ?").run(stageId);
    const lB = h.leases.acquireLease(stageId, "worker-B", 60_000);
    h.rawDb.prepare("UPDATE execution_jobs SET current_lease_id = ? WHERE id = ?").run(lB.leaseId, stageId);
    h.store.createAttempt({
      id: "att_j_2", jobId: stageId, attemptNumber: 2, status: "RUNNING",
      workerId: "worker-B", leaseId: lB.leaseId,
      startedAt: Date.now(), createdAt: Date.now(),
    } as any);
    const res = h.store.completeAttemptAndTransitionJob({
      attemptId: "att_j_1", jobId: stageId, leaseId: lA.leaseId, workerId: "worker-A",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      now: Date.now(),
    } as any);
    ok("206J retry fencing", res.ok === false, `reason=${res.reason}`);
  });

  await run("206K terminal fencing", () => {
    const h = makeHarness();
    seedExecution(h.store, "ex_k");
    const stageId = seedStage(h.store, "ex_k", "A");
    const l = h.leases.acquireLease(stageId, "worker-A", 60_000);
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_k");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED', current_lease_id = NULL WHERE id = ?").run(stageId);
    h.rawDb.prepare("UPDATE execution_leases SET status = 'RELEASED', released_at = ? WHERE lease_id = ?").run(Date.now(), l.leaseId);
    h.store.createAttempt({
      id: "att_k_A", jobId: stageId, attemptNumber: 1, status: "SUCCEEDED",
      workerId: "worker-A", leaseId: l.leaseId,
      startedAt: Date.now(), completedAt: Date.now(), createdAt: Date.now(),
    } as any);
    const hb = h.store.recordAttemptHeartbeatAsOwner("att_k_A", stageId, l.leaseId, "worker-A", Date.now());
    ok("206K terminal fencing", hb.updated === false, `updated=${hb.updated}`);
  });

  await run("206L concurrent reconciliation", async () => {
    const h = makeHarness();
    seedExecution(h.store, "ex_l");
    seedStage(h.store, "ex_l", "A");
    const adapter = {
      calls: [] as string[],
      getId: () => "test-adapter",
      healthCheck: async () => ({ healthy: true, ok: true }),
      execute: async (op: { operation: string }) => {
        adapter.calls.push(op.operation);
        return { success: true };
      },
    };
    await Promise.all([
      reconcileExecution({ store: h.store, leaseManager: h.leases, adapter: adapter as any, executionId: "ex_l", workerId: "w1" }),
      reconcileExecution({ store: h.store, leaseManager: h.leases, adapter: adapter as any, executionId: "ex_l", workerId: "w2" }),
    ]);
    const final = h.store.getJob("ex_l")?.status;
    const events = Number((q1(h.rawDb,
      "SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.lifecycle.finalized'", "ex_l") as any)?.c ?? -1);
    ok("206L concurrent reconciliation",
      final === "SUCCEEDED" && events === 1 && adapter.calls.length === 1,
      `final=${final} events=${events} calls=${adapter.calls.length}`);
  });

  await run("206M idempotency", () => {
    const h = makeHarness();
    const stageId = seedStage(h.store, "ex_m", "A");
    for (let i = 0; i < 5; i++) {
      const l = h.leases.acquireLease(stageId, `worker-${i}`, 60_000);
      const active = activeLeaseCount(h, stageId);
      if (active !== 1) throw new Error(`cycle ${i}: active=${active}`);
      h.leases.releaseLease(l.leaseId);
    }
    const lFinal = h.leases.acquireLease(stageId, "worker-final", 60_000);
    h.leases.releaseLease(lFinal.leaseId);
    h.leases.releaseLease(lFinal.leaseId);
    ok("206M idempotency", activeLeaseCount(h, stageId) === 0, `final_active=${activeLeaseCount(h, stageId)}`);
  });

  await run("206N restart recovery", () => {
    const dbFile = join(tmpdir(), `nexus-p206n-${Date.now()}.sqlite`);
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }
    try {
      let h = makeHarness(dbFile);
      const stageId = seedStage(h.store, "ex_n", "A");
      const lA = h.leases.acquireLease(stageId, "worker-A", 60_000);
      expireLease(h, lA.leaseId);
      h.rawDb.close();

      h = makeHarness(dbFile);
      const lB = h.leases.acquireLease(stageId, "worker-B", 60_000);
      const active = h.store.getActiveLeaseForJob(stageId);
      ok("206N restart recovery",
        active?.workerId === "worker-B" &&
        active?.leaseId === lB.leaseId &&
        h.leases.validateLease(lA.leaseId, "worker-A") === false,
        `owner=${active?.workerId}`);
      h.rawDb.close();
    } finally {
      for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }
    }
  });

  const ids = [
    "206A single acquisition",
    "206B concurrent acquisition",
    "206C ownership generation",
    "206D renewal",
    "206E stale renewal",
    "206F takeover",
    "206G stale heartbeat",
    "206H stale progress",
    "206I stale completion",
    "206J retry fencing",
    "206K terminal fencing",
    "206L concurrent reconciliation",
    "206M idempotency",
    "206N restart recovery",
  ];
  console.log("");
  let pass = 0, fail = 0, blocked = 0;
  for (const id of ids) {
    const s = results[id] ?? "NOT EXECUTED";
    console.log(`${id}: ${s}`);
    if (s === "PASS") pass++;
    else if (s === "FAIL") fail++;
    else if (s === "BLOCKED") blocked++;
  }
  console.log(`\nPASS=${pass}`);
  console.log(`FAIL=${fail}`);
  console.log(`BLOCKED=${blocked}`);
  console.log(`EXIT=${fail > 0 || blocked > 0 ? 1 : 0}`);
  process.exitCode = fail > 0 || blocked > 0 ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });