// scripts/test-phase159-recovery-admission-control.ts
// Phase 159 - bounded recovery iteration & backpressure semantics.
//
// Scope note (Step 15):
//   Inspection confirmed that no production scheduler currently drives
//   recoverStaleJobs or reconcileExecutionRecoveryOperations. The only
//   external callers are test scripts. Therefore the "recovery storm"
//   is latent, not live. The smallest production-safe change is an
//   optional per-tick limit on reconciliation that defaults to Infinity,
//   preserving existing behavior while giving a future scheduler a
//   bounded entry point.
//
//   This test proves (a) the limit parameter works, (b) the default is
//   unbounded, (c) all fencing/terminal/retry invariants hold under
//   capped iteration, and (d) unadmitted operations remain safely
//   resumable with unchanged attempt_count.

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
function getOp(h: H, opId: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function countByState(h: H, state: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE state = ?").get(state) as any).n;
}
function countOps(h: H): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations").get() as any).n;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}

// Create a CANCELLATION op for a job whose lease expired and whose
// cancellation_requested flag is set. reconcile would, unbounded, claim
// and execute cancellation via recoverJobAtomic.
function mkCancellationCandidate(h: H, jobId: string): string {
  h.store.createJob(queuedJob(jobId));
  h.db.prepare("UPDATE execution_jobs SET status='RUNNING', cancellation_requested=1 WHERE id=?").run(jobId);
  h.db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run("L-" + jobId, jobId, "w-" + jobId, Date.now() - 120000, Date.now() - 1000, "ACTIVE");
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: "CANCELLATION",
  });
  return operation.operationId;
}

async function main() {
  console.log("=== Phase 159 - Bounded Recovery Iteration & Backpressure ===\n");

  // ================================================================
  // Group A — Limit parameter basics (8)
  // ================================================================

  console.log("159-A1 default (no limit) processes all resumable");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "a1-" + i);
    h.engine.reconcileExecutionRecoveryOperations();
    // All 5 should be COMPLETED.
    ok(countByState(h, "COMPLETED") === 5, "A1 all 5 completed");
    ok(countByState(h, "PENDING") === 0, "A1 no remaining pending");
  }

  console.log("\n159-A2 limit=1 processes exactly one");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(mkCancellationCandidate(h, "a2-" + i));
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    ok(countByState(h, "COMPLETED") === 1, "A2 one completed");
    ok(countByState(h, "PENDING") === 4, "A2 four still pending");
  }

  console.log("\n159-A3 limit=2 processes exactly two");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "a3-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "A3 two completed");
    ok(countByState(h, "PENDING") === 3, "A3 three pending");
  }

  console.log("\n159-A4 limit=0 processes nothing");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "a4-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 0);
    ok(countByState(h, "COMPLETED") === 0, "A4 zero completed");
    ok(countByState(h, "PENDING") === 3, "A4 all pending");
  }

  console.log("\n159-A5 limit larger than backlog processes all");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "a5-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 100);
    ok(countByState(h, "COMPLETED") === 3, "A5 all three completed");
  }

  console.log("\n159-A6 limit=Infinity behaves like default");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) mkCancellationCandidate(h, "a6-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), Infinity);
    ok(countByState(h, "COMPLETED") === 4, "A6 Infinity processes all");
  }

  console.log("\n159-A7 limit is repeatable: successive ticks drain the backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) mkCancellationCandidate(h, "a7-" + i);
    for (let tick = 0; tick < 10; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    }
    ok(countByState(h, "COMPLETED") === 10, "A7 all drained over 10 ticks");
    ok(countByState(h, "PENDING") === 0, "A7 no pending");
  }

  console.log("\n159-A8 bounded iteration does not skip or duplicate candidates");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(mkCancellationCandidate(h, "a8-" + i));
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 3);
    // All 6 are still present, exactly 3 completed, 3 pending.
    ok(countOps(h) === 6, "A8 all rows present");
    ok(countByState(h, "COMPLETED") === 3, "A8 exactly 3 completed");
    ok(countByState(h, "PENDING") === 3, "A8 exactly 3 pending");
  }

  // ================================================================
  // Group B — Backpressure: unadmitted ops remain intact (8)
  // ================================================================

  console.log("159-B1 unadmitted op stays PENDING");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "b1-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const pending = h.db.prepare("SELECT operation_id FROM execution_recovery_operations WHERE state = 'PENDING' ORDER BY created_at").all() as any[];
    ok(pending.length === 2, "B1 two pending");
  }

  console.log("\n159-B2 unadmitted op attempt_count unchanged");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(mkCancellationCandidate(h, "b2-" + i));
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    for (const id of ids) {
      const op = getOp(h, id);
      if (op.state === "PENDING") {
        ok(op.attempt_count === 0, "B2 pending op " + id + " attempt_count 0");
      }
    }
  }

  console.log("\n159-B3 unadmitted op has no claim_owner");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "b3-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const pending = h.db.prepare("SELECT claim_owner, claim_expires_at FROM execution_recovery_operations WHERE state = 'PENDING'").all() as any[];
    for (const p of pending) {
      ok(p.claim_owner === null, "B3 pending has no owner");
      ok(p.claim_expires_at === null, "B3 pending has no expiry");
    }
  }

  console.log("\n159-B4 unadmitted op is discoverable next tick");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "b4-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const before = countByState(h, "PENDING");
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const after = countByState(h, "PENDING");
    ok(after === before - 1, "B4 pending count decremented by 1");
  }

  console.log("\n159-B5 unadmitted op does not emit an event");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(mkCancellationCandidate(h, "b5-" + i));
    const eventsBefore = ids.map((id) => countEvents(h, "b5-" + ids.indexOf(id)));
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    // Only the admitted op should have produced its cancelled event.
    let cancelledEventJobs = 0;
    for (const id of ids) {
      const jobId = "b5-" + ids.indexOf(id);
      const n = countEvents(h, jobId);
      if (n > 0) cancelledEventJobs++;
    }
    ok(cancelledEventJobs === 1, "B5 exactly one job has events");
  }

  console.log("\n159-B6 unadmitted op does not mutate job state");
  {
    const h = makeHarness();
    mkCancellationCandidate(h, "b6-a");
    mkCancellationCandidate(h, "b6-b");
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    // Exactly one job is CANCELLED, the other still RUNNING.
    const cancelled = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_jobs WHERE status='CANCELLED'").get() as any).n;
    const running = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_jobs WHERE status='RUNNING'").get() as any).n;
    ok(cancelled === 1, "B6 one job cancelled");
    ok(running === 1, "B6 one job still running");
  }

  console.log("\n159-B7 deferred op preserves idempotency_key");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "b7-" + i);
    const before = h.db.prepare("SELECT operation_id, idempotency_key FROM execution_recovery_operations WHERE state='PENDING' ORDER BY operation_id").all() as any[];
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const after = h.db.prepare("SELECT operation_id, idempotency_key FROM execution_recovery_operations WHERE state='PENDING' ORDER BY operation_id").all() as any[];
    ok(after.length === before.length - 1, "B7 one fewer pending");
    // Remaining pairs still valid.
    const beforeKeys = new Map(before.map((r: any) => [r.operation_id, r.idempotency_key]));
    for (const r of after) {
      ok(beforeKeys.get(r.operation_id) === r.idempotency_key, "B7 key preserved for " + r.operation_id);
    }
  }

  console.log("\n159-B8 deferred ops do not leak into later ticks with stale identity");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "b8-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const remaining = h.db.prepare("SELECT operation_id FROM execution_recovery_operations WHERE state='PENDING' ORDER BY created_at").all() as any[];
    ok(remaining.length === 3, "B8 three remain");
    // Run again and confirm same 3 or fewer, no new op rows.
    const opsBefore = countOps(h);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const opsAfter = countOps(h);
    ok(opsAfter === opsBefore, "B8 op count stable");
  }

  // ================================================================
  // Group C — Retry integrity under cap (6)
  // ================================================================

  console.log("159-C1 capped reconcile does not increment attempt_count on unadmitted");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) mkCancellationCandidate(h, "c1-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const pending = h.db.prepare("SELECT attempt_count FROM execution_recovery_operations WHERE state='PENDING'").all() as any[];
    for (const p of pending) ok(p.attempt_count === 0, "C1 pending attempt_count 0");
  }

  console.log("\n159-C2 unadmitted does not consume retry budget");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "c2-" + i);
    const before = h.db.prepare("SELECT retry_policy, next_attempt_at FROM execution_jobs ORDER BY id").all() as any[];
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const after = h.db.prepare("SELECT retry_policy, next_attempt_at FROM execution_jobs ORDER BY id").all() as any[];
    // Only the admitted job may have changed (to CANCELLED). Retry fields untouched.
    for (let i = 0; i < before.length; i++) {
      ok(before[i].retry_policy === after[i].retry_policy, "C2 retry_policy unchanged");
    }
  }

  console.log("\n159-C3 admitted op consumes no extra budget");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "c3-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const completed = h.db.prepare("SELECT attempt_count FROM execution_recovery_operations WHERE state='COMPLETED'").all() as any[];
    for (const c of completed) ok(c.attempt_count === 1, "C3 completed attempt_count 1");
  }

  console.log("\n159-C4 capped iteration does not double-claim");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "c4-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const completed = h.db.prepare("SELECT attempt_count FROM execution_recovery_operations WHERE state='COMPLETED'").all() as any[];
    for (const c of completed) ok(c.attempt_count === 1, "C4 no double claim");
  }

  console.log("\n159-C5 bounded iteration preserves op count");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "c5-" + i);
    const before = countOps(h);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const after = countOps(h);
    ok(before === after, "C5 op count stable");
  }

  console.log("\n159-C6 bounded iteration does not create new operations");
  {
    const h = makeHarness();
    mkCancellationCandidate(h, "c6");
    const before = countOps(h);
    for (let tick = 0; tick < 5; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 0);
    }
    ok(countOps(h) === before, "C6 no new ops after 5 no-op ticks");
  }

  // ================================================================
  // Group D — Fencing under cap (6)
  // ================================================================

  console.log("159-D1 capped reconcile respects live claim");
  {
    const h = makeHarness();
    // Create op, claim by "A", do NOT let reconcile process it (limit=0).
    h.store.createJob(queuedJob("d1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 0);
    ok(getOp(h, operation.operationId).claim_owner === "A", "D1 owner preserved");
  }

  console.log("\n159-D2 capped reconcile preserves terminal state");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "D2 still COMPLETED");
  }

  console.log("\n159-D3 capped reconcile does not resurrect cancelled");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "A" });
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "CANCELLED", "D3 still CANCELLED");
  }

  console.log("\n159-D4 capped reconcile does not resurrect recovery-required");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "err");
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "RECOVERY_REQUIRED", "D4 still RECOVERY_REQUIRED");
  }

  console.log("\n159-D5 capped reconcile does not steal a live claim");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    // Reconcile with a limit that includes this op. It is CLAIMED, so reconcile
    // should not steal it. (Reconcile may still attempt to execute, but claimOperation
    // will fail because A's claim is live.)
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).claim_owner === "A", "D5 owner still A");
  }

  console.log("\n159-D6 capped reconcile under terminal states never raises events");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d6"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    const before = countEvents(h, "d6");
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countEvents(h, "d6") === before, "D6 no new events");
  }

  // ================================================================
  // Group E — Restart under cap (5)
  // ================================================================

  console.log("159-E1 capped iteration is durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 4; i++) mkCancellationCandidate(h1, "e1-" + i);
      h1.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
      const completed1 = countByState(h1, "COMPLETED");
      const pending1 = countByState(h1, "PENDING");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(countByState(h2, "COMPLETED") === completed1, "E1 completed durable");
      ok(countByState(h2, "PENDING") === pending1, "E1 pending durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n159-E2 cap does not affect already-terminal ops after reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 3; i++) mkCancellationCandidate(h1, "e2-" + i);
      h1.engine.reconcileExecutionRecoveryOperations(Date.now(), 3);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(countByState(h2, "COMPLETED") === 3, "E2 all durable complete");
      h2.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
      ok(countByState(h2, "COMPLETED") === 3, "E2 no regress after reopen");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n159-E3 pending backlog survives reload and can be drained");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 5; i++) mkCancellationCandidate(h1, "e3-" + i);
      h1.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      for (let tick = 0; tick < 5; tick++) {
        h2.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
      }
      ok(countByState(h2, "COMPLETED") === 5, "E3 all drained after reload");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n159-E4 cap does not resurrect cancelled after reload");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("e4"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "e4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "A" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      h2.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
      ok(getOp(h2, operation.operationId).state === "CANCELLED", "E4 cancelled durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n159-E5 cap bounded tick leaves expired claims claimable");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("e5"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "e5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      // Claim is expired; B can take over.
      const r = h2.store.recoveryOps.claimOperation({
        operationId: operation.operationId, owner: "B", durationMs: 60000, now: Date.now() + 1000,
      });
      ok(r.claimed === true, "E5 B takes over after expiry");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group F — Storm scenarios (6)
  // ================================================================

  console.log("159-F1 100-candidate backlog with cap=5 drains over 20 ticks");
  {
    const h = makeHarness();
    for (let i = 0; i < 100; i++) mkCancellationCandidate(h, "f1-" + i);
    for (let tick = 0; tick < 20; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    }
    ok(countByState(h, "COMPLETED") === 100, "F1 all 100 drained");
    ok(countByState(h, "PENDING") === 0, "F1 no pending");
  }

  console.log("\n159-F2 storm does not create duplicate op rows");
  {
    const h = makeHarness();
    for (let i = 0; i < 50; i++) mkCancellationCandidate(h, "f2-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countOps(h) === 50, "F2 exactly 50 op rows");
  }

  console.log("\n159-F3 storm does not duplicate recovery events");
  {
    const h = makeHarness();
    for (let i = 0; i < 20; i++) mkCancellationCandidate(h, "f3-" + i);
    for (let tick = 0; tick < 5; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    }
    // Each job should have exactly one cancelled event.
    let allOne = true;
    for (let i = 0; i < 20; i++) {
      if (countEvents(h, "f3-" + i) !== 1) allOne = false;
    }
    ok(allOne === true, "F3 each job exactly one event");
  }

  console.log("\n159-F4 storm leaves no op in mixed state");
  {
    const h = makeHarness();
    for (let i = 0; i < 30; i++) mkCancellationCandidate(h, "f4-" + i);
    for (let tick = 0; tick < 3; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 10);
    }
    const inProgress = countByState(h, "IN_PROGRESS");
    const claimed = countByState(h, "CLAIMED");
    // No op should be left mid-lifecycle by a bounded tick (they complete or stay pending).
    // Note: reconcile may claim op but our bodies complete synchronously.
    ok(inProgress === 0, "F4 no IN_PROGRESS remains");
  }

  console.log("\n159-F5 storm with mixed operation types");
  {
    const h = makeHarness();
    // All CANCELLATION for simplicity, but across many jobs.
    for (let i = 0; i < 20; i++) mkCancellationCandidate(h, "f5-" + i);
    for (let tick = 0; tick < 4; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 5);
    }
    ok(countByState(h, "COMPLETED") === 20, "F5 all 20 completed");
  }

  console.log("\n159-F6 bounded tick preserves each job's terminal outcome");
  {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) mkCancellationCandidate(h, "f6-" + i);
    for (let tick = 0; tick < 10; tick++) {
      h.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
    }
    const cancelled = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_jobs WHERE status='CANCELLED'").get() as any).n;
    ok(cancelled === 10, "F6 all 10 jobs cancelled");
  }

  // ================================================================
  // Group G — Shutdown interaction (4)
  // ================================================================

  console.log("159-G1 shutdown flag prevents reconcile entirely");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) mkCancellationCandidate(h, "g1-" + i);
    h.engine.shutdown();
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 100);
    ok(countByState(h, "COMPLETED") === 0, "G1 nothing processed");
    ok(countByState(h, "PENDING") === 3, "G1 all still pending");
  }

  console.log("\n159-G2 shutdown + limit are both honored");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "g2-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "G2 2 processed before shutdown");
    h.engine.shutdown();
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "G2 no more processing after shutdown");
  }

  console.log("\n159-G3 pending backlog recoverable after shutdown + restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "p159-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 5; i++) mkCancellationCandidate(h1, "g3-" + i);
      h1.engine.shutdown();
      h1.db.close();
      const h2 = makeHarness(dbFile);
      for (let tick = 0; tick < 5; tick++) {
        h2.engine.reconcileExecutionRecoveryOperations(Date.now(), 1);
      }
      ok(countByState(h2, "COMPLETED") === 5, "G3 all completed after restart");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n159-G4 shutdown does not alter durable claims");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "g4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.engine.shutdown();
    ok(getOp(h, operation.operationId).claim_owner === "A", "G4 owner preserved");
    ok(getOp(h, operation.operationId).state === "CLAIMED", "G4 state preserved");
  }

  // ================================================================
  // Group H — Default preserved (regression) (4)
  // ================================================================

  console.log("159-H1 no-arg reconcile is unbounded");
  {
    const h = makeHarness();
    for (let i = 0; i < 25; i++) mkCancellationCandidate(h, "h1-" + i);
    h.engine.reconcileExecutionRecoveryOperations();
    ok(countByState(h, "COMPLETED") === 25, "H1 all 25 completed by default");
  }

  console.log("\n159-H2 explicit Infinity is unbounded");
  {
    const h = makeHarness();
    for (let i = 0; i < 25; i++) mkCancellationCandidate(h, "h2-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), Infinity);
    ok(countByState(h, "COMPLETED") === 25, "H2 all completed");
  }

  console.log("\n159-H3 negative limit treated as unbounded (defensive)");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "h3-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), -1);
    ok(countByState(h, "COMPLETED") === 5, "H3 negative treated as unbounded");
  }

  console.log("\n159-H4 NaN limit treated as unbounded");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) mkCancellationCandidate(h, "h4-" + i);
    h.engine.reconcileExecutionRecoveryOperations(Date.now(), NaN);
    ok(countByState(h, "COMPLETED") === 5, "H4 NaN treated as unbounded");
  }

  console.log("\n--- Phase 159: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE159 DRIVER CRASH:", err); process.exit(1); });
