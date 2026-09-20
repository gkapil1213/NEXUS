// scripts/test-phase157-recovery-operation-idempotency.ts
// Phase 157 - durable recovery operation identity & idempotent creation.
//
// Verifies that one logical recovery intent maps to exactly one durable
// operation identity, under replay, restart, terminal states, and competing
// insert attempts.
//
// Concurrency note: better-sqlite3 is synchronous, so all operations here
// serialize at the JS event loop. The authoritative guarantee is the SQLite
// UNIQUE INDEX on idempotency_key — proven directly by attempting duplicate
// INSERTs (which must throw SQLITE_CONSTRAINT_UNIQUE) alongside the store's
// SELECT-then-INSERT-fallback-read behavior. Nothing in this file relies on
// timing or process-local state.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionJob } from "../src/core/execution-models";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}

interface H { db: Database.Database; store: ExecutionStore; engine: ExecutionEngine; }

function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const engine = new ExecutionEngine(
    store,
    { detectLostWorkers: () => [] } as any,
    { recoverExpiredLeases: () => [] } as any,
    {} as any,
    {}
  );
  return { db: rawDb, store, engine };
}
function queuedJob(id: string): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as ExecutionJob;
}
function opCount(h: H, jobId?: string): number {
  if (jobId) return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations").get() as any).n;
}
function getOp(h: H, opId: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function getOpByKey(h: H, key: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE idempotency_key = ?").get(key) as any;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}
function seedJob(h: H, jobId: string) {
  h.store.createJob(queuedJob(jobId));
}

async function main() {
  console.log("=== Phase 157 - Recovery Operation Identity & Idempotency ===\n");

  // ================================================================
  // Group A - Basic identity (4)
  // ================================================================

  console.log("157-A1 first create returns operation with created:true");
  {
    const h = makeHarness();
    seedJob(h, "a1");
    const r = h.store.recoveryOps.createOrGetOperation({
      jobId: "a1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    ok(r.created === true, "A1 created flag true");
    ok(!!r.operation.operationId, "A1 operation_id assigned");
    ok(getOp(h, r.operation.operationId) !== undefined, "A1 row persisted");
  }

  console.log("\n157-A2 operation_id is stable");
  {
    const h = makeHarness();
    seedJob(h, "a2");
    const r1 = h.store.recoveryOps.createOrGetOperation({
      jobId: "a2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    const id1 = r1.operation.operationId;
    const r2 = h.store.recoveryOps.createOrGetOperation({
      jobId: "a2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    ok(r2.operation.operationId === id1, "A2 id unchanged");
  }

  console.log("\n157-A3 second create returns same operation, created:false");
  {
    const h = makeHarness();
    seedJob(h, "a3");
    const r1 = h.store.recoveryOps.createOrGetOperation({
      jobId: "a3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    const r2 = h.store.recoveryOps.createOrGetOperation({
      jobId: "a3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    ok(r2.created === false, "A3 second created false");
    ok(r2.operation.operationId === r1.operation.operationId, "A3 same id");
  }

  console.log("\n157-A4 third create converges");
  {
    const h = makeHarness();
    seedJob(h, "a4");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = h.store.recoveryOps.createOrGetOperation({
        jobId: "a4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
      });
      ids.add(r.operation.operationId);
    }
    ok(ids.size === 1, "A4 one operation id");
    ok(opCount(h, "a4") === 1, "A4 one row");
  }

  // ================================================================
  // Group B - Replay across states (7)
  // ================================================================

  console.log("\n157-B1 replay before claim");
  {
    const h = makeHarness();
    seedJob(h, "b1");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    ok(r1.operation.operationId === r2.operation.operationId, "B1 same id");
    ok(getOp(h, r1.operation.operationId).state === "PENDING", "B1 still PENDING");
  }

  console.log("\n157-B2 replay after claim");
  {
    const h = makeHarness();
    seedJob(h, "b2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    ok(r2.created === false, "B2 created false");
    ok(r2.operation.operationId === r1.operation.operationId, "B2 same id");
    ok(getOp(h, r1.operation.operationId).state === "CLAIMED", "B2 state unchanged");
  }

  console.log("\n157-B3 replay after IN_PROGRESS");
  {
    const h = makeHarness();
    seedJob(h, "b3");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markInProgress(r1.operation.operationId, "A");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "B3 same id");
    ok(getOp(h, r1.operation.operationId).state === "IN_PROGRESS", "B3 still IN_PROGRESS");
  }

  console.log("\n157-B4 replay after COMPLETED");
  {
    const h = makeHarness();
    seedJob(h, "b4");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(r2.created === false, "B4 created false");
    ok(r2.operation.operationId === r1.operation.operationId, "B4 same id");
    ok(getOp(h, r1.operation.operationId).state === "COMPLETED", "B4 stays COMPLETED");
    ok(opCount(h, "b4") === 1, "B4 one row");
  }

  console.log("\n157-B5 replay after FAILED");
  {
    const h = makeHarness();
    seedJob(h, "b5");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(r1.operation.operationId, "A", "err");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "B5 same id");
    ok(getOp(h, r1.operation.operationId).state === "FAILED", "B5 stays FAILED");
  }

  console.log("\n157-B6 replay after RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    seedJob(h, "b6");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(r1.operation.operationId, "A", "err");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "B6 same id");
    ok(getOp(h, r1.operation.operationId).state === "RECOVERY_REQUIRED", "B6 stays RECOVERY_REQUIRED");
  }

  console.log("\n157-B7 replay after CANCELLED");
  {
    const h = makeHarness();
    seedJob(h, "b7");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "b7", leaseId: "L7", workerId: "w7", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: r1.operation.operationId, owner: "A" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "b7", leaseId: "L7", workerId: "w7", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "B7 same id");
    ok(getOp(h, r1.operation.operationId).state === "CANCELLED", "B7 stays CANCELLED");
  }

  // ================================================================
  // Group C - Attempt count (6)
  // ================================================================

  console.log("\n157-C1 create does not increment attempt_count");
  {
    const h = makeHarness();
    seedJob(h, "c1");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "c1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    ok(getOp(h, r.operation.operationId).attempt_count === 0, "C1 attempt_count 0");
  }

  console.log("\n157-C2 duplicate create does not increment");
  {
    const h = makeHarness();
    seedJob(h, "c2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "c2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "c2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "c2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    ok(getOp(h, r1.operation.operationId).attempt_count === 0, "C2 still 0");
  }

  console.log("\n157-C3 claim increments once");
  {
    const h = makeHarness();
    seedJob(h, "c3");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "c3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "A", durationMs: 60000 });
    ok(getOp(h, r.operation.operationId).attempt_count === 1, "C3 attempt_count 1");
  }

  console.log("\n157-C4 replay after claim does not increment");
  {
    const h = makeHarness();
    seedJob(h, "c4");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "c4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.createOrGetOperation({ jobId: "c4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(getOp(h, r.operation.operationId).attempt_count === 1, "C4 still 1");
  }

  console.log("\n157-C5 takeover increments only once more");
  {
    const h = makeHarness();
    const t = Date.now();
    seedJob(h, "c5");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "c5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "A", durationMs: 60000, now: t });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(getOp(h, r.operation.operationId).attempt_count === 2, "C5 attempt_count 2");
  }

  console.log("\n157-C6 replay after takeover does not increment");
  {
    const h = makeHarness();
    const t = Date.now();
    seedJob(h, "c6");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "c6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "A", durationMs: 60000, now: t });
    h.store.recoveryOps.claimOperation({ operationId: r.operation.operationId, owner: "B", durationMs: 60000, now: t + 120000 });
    h.store.recoveryOps.createOrGetOperation({ jobId: "c6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    ok(getOp(h, r.operation.operationId).attempt_count === 2, "C6 still 2");
  }

  // ================================================================
  // Group D - Concurrent creation (5)
  // ================================================================

  console.log("\n157-D1 two callers converge to one operation");
  {
    const h = makeHarness();
    seedJob(h, "d1");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "d1", leaseId: "L1", workerId: "wA", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "d1", leaseId: "L1", workerId: "wB", operationType: "CANCELLATION" });
    ok(r1.operation.operationId === r2.operation.operationId, "D1 same id");
    ok(opCount(h, "d1") === 1, "D1 one row");
  }

  console.log("\n157-D2 four callers converge");
  {
    const h = makeHarness();
    seedJob(h, "d2");
    const ids = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = h.store.recoveryOps.createOrGetOperation({ jobId: "d2", leaseId: "L2", workerId: "w" + i, operationType: "CANCELLATION" });
      ids.add(r.operation.operationId);
    }
    ok(ids.size === 1, "D2 one unique id");
    ok(opCount(h, "d2") === 1, "D2 one row");
  }

  console.log("\n157-D3 eight callers converge");
  {
    const h = makeHarness();
    seedJob(h, "d3");
    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = h.store.recoveryOps.createOrGetOperation({ jobId: "d3", leaseId: "L3", workerId: "w" + i, operationType: "CANCELLATION" });
      ids.add(r.operation.operationId);
    }
    ok(ids.size === 1, "D3 one unique id");
    ok(opCount(h, "d3") === 1, "D3 one row");
  }

  console.log("\n157-D4 DB UNIQUE INDEX rejects duplicate idempotency_key");
  {
    const h = makeHarness();
    seedJob(h, "d4");
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "d4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    const key = getOp(h, r.operation.operationId).idempotency_key;
    let rejected = false;
    try {
      h.db.prepare(
        "INSERT INTO execution_recovery_operations " +
        "(operation_id, job_id, lease_id, worker_id, operation_type, state, idempotency_key, attempt_count, created_at, updated_at) " +
        "VALUES (?,?,?,?,?, 'PENDING', ?, 0, ?, ?)"
      ).run("dup-op-id", "d4", "L4", "w4", "CANCELLATION", key, Date.now(), Date.now());
    } catch (e: any) {
      if (/UNIQUE constraint failed/i.test(e.message ?? "")) rejected = true;
    }
    ok(rejected === true, "D4 DB rejects duplicate key");
    ok(opCount(h, "d4") === 1, "D4 still one row");
  }

  console.log("\n157-D5 store converges even when INSERT race is simulated");
  {
    const h = makeHarness();
    seedJob(h, "d5");
    // Pre-populate with the exact key the store would compute, bypassing the store.
    const key = "CANCELLATION:d5:L5";
    h.db.prepare(
      "INSERT INTO execution_recovery_operations " +
      "(operation_id, job_id, lease_id, worker_id, operation_type, state, idempotency_key, attempt_count, created_at, updated_at) " +
      "VALUES (?,?,?,?,?, 'PENDING', ?, 0, ?, ?)"
    ).run("pre-seeded-d5", "d5", "L5", "wPre", "CANCELLATION", key, Date.now(), Date.now());
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "d5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    ok(r.created === false, "D5 found existing");
    ok(r.operation.operationId === "pre-seeded-d5", "D5 returned pre-seeded id");
    ok(opCount(h, "d5") === 1, "D5 one row");
  }

  // ================================================================
  // Group E - Restart (4)
  // ================================================================

  console.log("\n157-E1 duplicate after DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "e1");
      const r1 = h1.store.recoveryOps.createOrGetOperation({ jobId: "e1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const r2 = h2.store.recoveryOps.createOrGetOperation({ jobId: "e1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
      ok(r2.created === false, "E1 created false after reopen");
      ok(r2.operation.operationId === r1.operation.operationId, "E1 same id");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n157-E2 duplicate after claim + reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "e2");
      const r1 = h1.store.recoveryOps.createOrGetOperation({ jobId: "e2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
      h1.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const r2 = h2.store.recoveryOps.createOrGetOperation({ jobId: "e2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
      ok(r2.operation.operationId === r1.operation.operationId, "E2 same id");
      ok(getOp(h2, r1.operation.operationId).state === "CLAIMED", "E2 state durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n157-E3 duplicate after IN_PROGRESS + reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "e3");
      const r1 = h1.store.recoveryOps.createOrGetOperation({ jobId: "e3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
      h1.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.markInProgress(r1.operation.operationId, "A");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const r2 = h2.store.recoveryOps.createOrGetOperation({ jobId: "e3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
      ok(r2.operation.operationId === r1.operation.operationId, "E3 same id");
      ok(getOp(h2, r1.operation.operationId).state === "IN_PROGRESS", "E3 state durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n157-E4 duplicate after terminal + reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "e4");
      const r1 = h1.store.recoveryOps.createOrGetOperation({ jobId: "e4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
      h1.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const r2 = h2.store.recoveryOps.createOrGetOperation({ jobId: "e4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
      ok(r2.operation.operationId === r1.operation.operationId, "E4 same id");
      ok(getOp(h2, r1.operation.operationId).state === "COMPLETED", "E4 stays COMPLETED");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group F - Different intents (4)
  // ================================================================

  console.log("\n157-F1 different job does not collide");
  {
    const h = makeHarness();
    seedJob(h, "f1-a");
    seedJob(h, "f1-b");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "f1-a", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "f1-b", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    ok(r1.operation.operationId !== r2.operation.operationId, "F1 distinct ids");
    ok(opCount(h) === 2, "F1 two rows");
  }

  console.log("\n157-F2 different operation type does not collide");
  {
    const h = makeHarness();
    seedJob(h, "f2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "f2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "f2", leaseId: "L2", workerId: "w2", operationType: "TIMEOUT" });
    ok(r1.operation.operationId !== r2.operation.operationId, "F2 distinct ids");
    ok(opCount(h, "f2") === 2, "F2 two rows");
  }

  console.log("\n157-F3 different lease does not collide");
  {
    const h = makeHarness();
    seedJob(h, "f3");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "f3", leaseId: "L3-a", workerId: "w3", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "f3", leaseId: "L3-b", workerId: "w3", operationType: "CANCELLATION" });
    ok(r1.operation.operationId !== r2.operation.operationId, "F3 distinct ids");
    ok(opCount(h, "f3") === 2, "F3 two rows");
  }

  console.log("\n157-F4 null lease vs non-null lease do not collide");
  {
    const h = makeHarness();
    seedJob(h, "f4");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "f4", leaseId: null, workerId: "w4", operationType: "CANCELLATION" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "f4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(r1.operation.operationId !== r2.operation.operationId, "F4 distinct ids");
    ok(opCount(h, "f4") === 2, "F4 two rows");
  }

  // ================================================================
  // Group G - Idempotency conflicts (4)
  // ================================================================

  console.log("157-G1 compatible replay with explicit key converges");
  {
    const h = makeHarness();
    seedJob(h, "g1");
    const r1 = h.store.recoveryOps.createOrGetOperation({
      jobId: "g1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
      idempotencyKey: "explicit-key-g1",
    });
    const r2 = h.store.recoveryOps.createOrGetOperation({
      jobId: "g1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
      idempotencyKey: "explicit-key-g1",
    });
    ok(r1.operation.operationId === r2.operation.operationId, "G1 same op");
    ok(r2.created === false, "G1 second created false");
  }

  console.log("157-G2 explicit key collides across different jobs is returned as-is");
  {
    const h = makeHarness();
    seedJob(h, "g2-a");
    seedJob(h, "g2-b");
    const r1 = h.store.recoveryOps.createOrGetOperation({
      jobId: "g2-a", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
      idempotencyKey: "shared-g2",
    });
    const r2 = h.store.recoveryOps.createOrGetOperation({
      jobId: "g2-b", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
      idempotencyKey: "shared-g2",
    });
    // Explicit key wins. Callers converging on the same idempotency_key get the
    // existing op even if other fields differ. That is the idempotency contract.
    ok(r2.created === false, "G2 second returns existing");
    ok(r2.operation.operationId === r1.operation.operationId, "G2 same op id");
    ok(opCount(h) === 1, "G2 one row total");
  }

  console.log("157-G3 unknown explicit key creates new op");
  {
    const h = makeHarness();
    seedJob(h, "g3");
    h.store.recoveryOps.createOrGetOperation({
      jobId: "g3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
      idempotencyKey: "k1",
    });
    const r2 = h.store.recoveryOps.createOrGetOperation({
      jobId: "g3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
      idempotencyKey: "k2",
    });
    ok(r2.created === true, "G3 second created true");
    ok(opCount(h, "g3") === 2, "G3 two rows");
  }

  console.log("157-G4 idempotency_key is durable and retrievable");
  {
    const h = makeHarness();
    seedJob(h, "g4");
    const r = h.store.recoveryOps.createOrGetOperation({
      jobId: "g4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
      idempotencyKey: "my-key-g4",
    });
    const row = getOpByKey(h, "my-key-g4");
    ok(row !== undefined, "G4 retrievable by key");
    ok(row.operation_id === r.operation.operationId, "G4 matches op id");
  }

  // ================================================================
  // Group H - Terminal safety (6)
  // ================================================================

  console.log("157-H1 completed identity stable across replays");
  {
    const h = makeHarness();
    seedJob(h, "h1");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = h.store.recoveryOps.createOrGetOperation({ jobId: "h1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
      ids.add(r.operation.operationId);
    }
    ok(ids.size === 1, "H1 one id across replays");
    ok(opCount(h, "h1") === 1, "H1 one row");
  }

  console.log("\n157-H2 failed identity stable");
  {
    const h = makeHarness();
    seedJob(h, "h2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(r1.operation.operationId, "A", "err");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "h2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "H2 same id");
    ok(getOp(h, r1.operation.operationId).state === "FAILED", "H2 stays FAILED");
  }

  console.log("\n157-H3 recovery-required identity stable");
  {
    const h = makeHarness();
    seedJob(h, "h3");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(r1.operation.operationId, "A", "err");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "h3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "H3 same id");
    ok(getOp(h, r1.operation.operationId).state === "RECOVERY_REQUIRED", "H3 stays RECOVERY_REQUIRED");
  }

  console.log("\n157-H4 cancelled identity stable");
  {
    const h = makeHarness();
    seedJob(h, "h4");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: r1.operation.operationId, owner: "A" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "h4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "H4 same id");
    ok(getOp(h, r1.operation.operationId).state === "CANCELLED", "H4 stays CANCELLED");
  }

  console.log("\n157-H5 terminal replay does not create second row");
  {
    const h = makeHarness();
    seedJob(h, "h5");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    for (let i = 0; i < 10; i++) {
      h.store.recoveryOps.createOrGetOperation({ jobId: "h5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    }
    ok(opCount(h, "h5") === 1, "H5 one row");
  }

  console.log("\n157-H6 terminal replay does not resurrect");
  {
    const h = makeHarness();
    seedJob(h, "h6");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "h6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    h.store.recoveryOps.createOrGetOperation({ jobId: "h6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    ok(getOp(h, r1.operation.operationId).state === "COMPLETED", "H6 still COMPLETED");
    ok(getOp(h, r1.operation.operationId).completed_at !== null, "H6 completed_at preserved");
  }

  // ================================================================
  // Group I - Reconciliation (5)
  // ================================================================

  console.log("157-I1 reconciliation does not duplicate");
  {
    const h = makeHarness();
    seedJob(h, "i1");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "i1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    h.engine.reconcileExecutionRecoveryOperations();
    ok(opCount(h, "i1") === 1, "I1 one row after reconcile");
  }

  console.log("\n157-I2 repeated reconciliation does not duplicate");
  {
    const h = makeHarness();
    seedJob(h, "i2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "i2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(r1.operation.operationId, "A", "err");
    for (let i = 0; i < 5; i++) h.engine.reconcileExecutionRecoveryOperations();
    ok(opCount(h, "i2") === 1, "I2 one row");
  }

  console.log("\n157-I3 cancelled op remains cancelled after reconcile");
  {
    const h = makeHarness();
    seedJob(h, "i3");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "i3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: r1.operation.operationId, owner: "A" });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getOp(h, r1.operation.operationId).state === "CANCELLED", "I3 stays CANCELLED");
  }

  console.log("\n157-I4 terminal op remains terminal after reconcile");
  {
    const h = makeHarness();
    seedJob(h, "i4");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "i4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getOp(h, r1.operation.operationId).state === "COMPLETED", "I4 stays COMPLETED");
  }

  console.log("\n157-I5 operation count stable after reconcile");
  {
    const h = makeHarness();
    seedJob(h, "i5");
    for (let i = 0; i < 3; i++) {
      h.store.recoveryOps.createOrGetOperation({ jobId: "i5", leaseId: "L5", workerId: "w" + i, operationType: "CANCELLATION" });
    }
    const before = opCount(h, "i5");
    h.engine.reconcileExecutionRecoveryOperations();
    ok(opCount(h, "i5") === before, "I5 count unchanged");
  }

  // ================================================================
  // Group J - Side effect safety (4)
  // ================================================================

  console.log("157-J1 duplicate create does not mutate job state");
  {
    const h = makeHarness();
    seedJob(h, "j1");
    const before = (h.db.prepare("SELECT status FROM execution_jobs WHERE id = 'j1'").get() as any).status;
    h.store.recoveryOps.createOrGetOperation({ jobId: "j1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "j1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    const after = (h.db.prepare("SELECT status FROM execution_jobs WHERE id = 'j1'").get() as any).status;
    ok(before === after, "J1 job status unchanged");
  }

  console.log("\n157-J2 duplicate create does not create events");
  {
    const h = makeHarness();
    seedJob(h, "j2");
    const before = countEvents(h, "j2");
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.createOrGetOperation({ jobId: "j2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    }
    ok(countEvents(h, "j2") === before, "J2 no events added");
  }

  console.log("\n157-J3 duplicate create does not execute recovery body");
  {
    const h = makeHarness();
    seedJob(h, "j3");
    // The body of runRecoveryOperation mutates job state. Since we're calling
    // createOrGetOperation directly, no body runs — proving the store's
    // create path is side-effect-free.
    const before = (h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id = 'j3'").get() as any);
    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    const after = (h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id = 'j3'").get() as any);
    ok(JSON.stringify(before) === JSON.stringify(after), "J3 job untouched");
    ok(getOp(h, r.operation.operationId).attempt_count === 0, "J3 attempt_count 0");
  }

  console.log("\n157-J4 duplicate create does not consume retry budget");
  {
    const h = makeHarness();
    seedJob(h, "j4");
    h.store.recoveryOps.createOrGetOperation({ jobId: "j4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    const retryBefore = (h.db.prepare("SELECT retry_policy FROM execution_jobs WHERE id = 'j4'").get() as any).retry_policy;
    for (let i = 0; i < 3; i++) {
      h.store.recoveryOps.createOrGetOperation({ jobId: "j4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    }
    const retryAfter = (h.db.prepare("SELECT retry_policy FROM execution_jobs WHERE id = 'j4'").get() as any).retry_policy;
    ok(retryBefore === retryAfter, "J4 retry policy unchanged");
  }

  // ================================================================
  // Group K - Transactional safety (4)
  // ================================================================

  console.log("157-K1 successful creation is durable");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "k1");
      const r = h1.store.recoveryOps.createOrGetOperation({ jobId: "k1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, r.operation.operationId) !== undefined, "K1 durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n157-K2 DB reopen preserves identity");
  {
    const dir = mkdtempSync(join(tmpdir(), "p157-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      seedJob(h1, "k2");
      const r = h1.store.recoveryOps.createOrGetOperation({ jobId: "k2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
      const row1 = getOp(h1, r.operation.operationId);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const row2 = getOp(h2, r.operation.operationId);
      ok(row1.operation_id === row2.operation_id, "K2 op id stable");
      ok(row1.idempotency_key === row2.idempotency_key, "K2 key stable");
      ok(row1.job_id === row2.job_id, "K2 job stable");
      ok(row1.operation_type === row2.operation_type, "K2 type stable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n157-K3 no orphan row on pre-computed key collision");
  {
    const h = makeHarness();
    seedJob(h, "k3");
    const key = "CANCELLATION:k3:L3";
    h.db.prepare(
      "INSERT INTO execution_recovery_operations " +
      "(operation_id, job_id, lease_id, worker_id, operation_type, state, idempotency_key, attempt_count, created_at, updated_at) " +
      "VALUES (?,?,?,?,?, 'PENDING', ?, 0, ?, ?)"
    ).run("seed-k3", "k3", "L3", "wPre", "CANCELLATION", key, Date.now(), Date.now());

    let threw = false;
    try {
      h.db.prepare(
        "INSERT INTO execution_recovery_operations " +
        "(operation_id, job_id, lease_id, worker_id, operation_type, state, idempotency_key, attempt_count, created_at, updated_at) " +
        "VALUES (?,?,?,?,?, 'PENDING', ?, 0, ?, ?)"
      ).run("dup-k3", "k3", "L3", "wDup", "CANCELLATION", key, Date.now(), Date.now());
    } catch { threw = true; }
    ok(threw === true, "K3 duplicate INSERT throws");
    ok(opCount(h, "k3") === 1, "K3 no orphan row");
  }

  console.log("\n157-K4 store handles pre-existing row gracefully");
  {
    const h = makeHarness();
    seedJob(h, "k4");
    const key = "CANCELLATION:k4:L4";
    h.db.prepare(
      "INSERT INTO execution_recovery_operations " +
      "(operation_id, job_id, lease_id, worker_id, operation_type, state, idempotency_key, attempt_count, created_at, updated_at) " +
      "VALUES (?,?,?,?,?, 'PENDING', ?, 0, ?, ?)"
    ).run("seed-k4", "k4", "L4", "wPre", "CANCELLATION", key, Date.now(), Date.now());

    const r = h.store.recoveryOps.createOrGetOperation({ jobId: "k4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(r.created === false, "K4 finds existing");
    ok(r.operation.operationId === "seed-k4", "K4 returns seed id");
    ok(opCount(h, "k4") === 1, "K4 no additional row");
  }

  // ================================================================
  // Group L - Concurrency + lifecycle (7)
  // ================================================================

  console.log("157-L1 create vs claim: create returns same op after claim");
  {
    const h = makeHarness();
    seedJob(h, "l1");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "l1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "L1 same id");
    ok(getOp(h, r1.operation.operationId).state === "CLAIMED", "L1 state preserved");
  }

  console.log("\n157-L2 create vs completion");
  {
    const h = makeHarness();
    seedJob(h, "l2");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(r1.operation.operationId, "A");
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "l2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "L2 same id");
    ok(getOp(h, r1.operation.operationId).state === "COMPLETED", "L2 COMPLETED");
  }

  console.log("\n157-L3 create vs cancellation");
  {
    const h = makeHarness();
    seedJob(h, "l3");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: r1.operation.operationId, owner: "A" });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "l3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "L3 same id");
    ok(getOp(h, r1.operation.operationId).state === "CANCELLED", "L3 CANCELLED");
  }

  console.log("\n157-L4 create vs takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    seedJob(h, "l4");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000, now: t });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "l4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "L4 same id");
    ok(getOp(h, r1.operation.operationId).claim_owner === "B", "L4 owner is B");
  }

  console.log("\n157-L5 duplicate after takeover does not increment");
  {
    const h = makeHarness();
    const t = Date.now();
    seedJob(h, "l5");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "A", durationMs: 60000, now: t });
    h.store.recoveryOps.claimOperation({ operationId: r1.operation.operationId, owner: "B", durationMs: 60000, now: t + 120000 });
    h.store.recoveryOps.createOrGetOperation({ jobId: "l5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    ok(getOp(h, r1.operation.operationId).attempt_count === 2, "L5 still 2");
  }

  console.log("\n157-L6 stale worker cannot create a second identity");
  {
    const h = makeHarness();
    seedJob(h, "l6");
    const r1 = h.store.recoveryOps.createOrGetOperation({ jobId: "l6", leaseId: "L6", workerId: "wA", operationType: "CANCELLATION" });
    // Even a "stale" worker (different worker_id) asking for the same logical
    // intent gets the same durable operation. worker_id is not part of the key.
    const r2 = h.store.recoveryOps.createOrGetOperation({ jobId: "l6", leaseId: "L6", workerId: "wSTALE", operationType: "CANCELLATION" });
    ok(r2.operation.operationId === r1.operation.operationId, "L6 same id");
    ok(opCount(h, "l6") === 1, "L6 one row");
  }

  console.log("\n157-L7 exactly one authoritative operation remains");
  {
    const h = makeHarness();
    seedJob(h, "l7");
    const ids = new Set<string>();
    // Simulate 10 interleaved create requests across multiple worker identities.
    for (let i = 0; i < 10; i++) {
      const r = h.store.recoveryOps.createOrGetOperation({ jobId: "l7", leaseId: "L7", workerId: "w" + (i % 3), operationType: "CANCELLATION" });
      ids.add(r.operation.operationId);
    }
    ok(ids.size === 1, "L7 exactly one id");
    ok(opCount(h, "l7") === 1, "L7 exactly one row");
  }

  console.log("\n--- Phase 157: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE157 DRIVER CRASH:", err); process.exit(1); });
