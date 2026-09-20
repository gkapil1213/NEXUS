// scripts/test-phase161-recovery-scheduler-capacity.ts
// Phase 161 - recovery scheduler capacity, concurrency, work-conservation.
//
// Baseline finding (Step 2-5):
//   The repository has NO production scheduler driving recovery reconciliation.
//   The only internal caller is recoverStaleJobs(), which invokes
//   reconcileExecutionRecoveryOperations(now) once per tick.
//   The `limit` parameter (Phase 159) is a per-call batch-size cap. It is not
//   a global execution capacity — there is no global capacity mechanism, and
//   none is required because:
//     - No scheduler runs reconcile in a hot loop.
//     - Cross-engine concurrency is fenced by claimOperation's CAS.
//     - Unprocessed ops stay PENDING and are discovered by the next caller.
//
//   This suite proves those properties under the Phase 159/160 semantics.
//   It does NOT introduce a second scheduler, queue, or capacity abstraction.
//
// Determinism: every seeded op uses an explicit `now`. No sleeps, no timers,
// no randomness.

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

interface H {
  db: Database.Database;
  store: ExecutionStore;
  engineA: ExecutionEngine;
  engineB: ExecutionEngine;
  engineC: ExecutionEngine;
}

function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const stubLease = { recoverExpiredLeases: () => [] };
  const stubWorkers = { detectLostWorkers: () => [] };
  const engineA = new ExecutionEngine(store, stubWorkers as any, stubLease as any, {} as any, {});
  const engineB = new ExecutionEngine(store, stubWorkers as any, stubLease as any, {} as any, {});
  const engineC = new ExecutionEngine(store, stubWorkers as any, stubLease as any, {} as any, {});
  return { db: rawDb, store, engineA, engineB, engineC };
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
// Seed a PENDING op whose job already satisfies the postcondition for its
// operation type. Reconcile will finalize without calling recoverJobAtomic.
function seedFinalizableOp(h: H, jobId: string, opType: string, createdAt: number): string {
  h.store.createJob(queuedJob(jobId));
  let targetStatus: string;
  switch (opType) {
    case "CANCELLATION":    targetStatus = "CANCELLED";       break;
    case "TIMEOUT":         targetStatus = "RETRY_SCHEDULED"; break;
    case "ORPHAN_RECOVERY": targetStatus = "QUEUED";          break;
    default:                targetStatus = "CANCELLED";
  }
  h.db.prepare("UPDATE execution_jobs SET status=? WHERE id=?").run(targetStatus, jobId);
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId,
    operationType: opType as any, now: createdAt,
  });
  return operation.operationId;
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
function resumableIds(h: H): string[] {
  return h.store.recoveryOps.listResumableOperations().map((o: any) => o.operationId);
}

async function main() {
  console.log("=== Phase 161 - Recovery Scheduler Capacity & Work Conservation ===\n");

  // ================================================================
  // Group A — Baseline capacity (7)
  // ================================================================

  console.log("161-A1 empty backlog");
  {
    const h = makeHarness();
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countOps(h) === 0, "A1 no ops created");
    ok(resumableIds(h).length === 0, "A1 resumable empty");
  }

  console.log("\n161-A2 one eligible operation");
  {
    const h = makeHarness();
    seedFinalizableOp(h, "a2", "CANCELLATION", 1_000_000_000_000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countByState(h, "COMPLETED") === 1, "A2 completed");
  }

  console.log("\n161-A3 backlog larger than capacity");
  {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) seedFinalizableOp(h, "a3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 3, "A3 exactly 3 processed");
    ok(countByState(h, "PENDING") === 7, "A3 7 pending");
  }

  console.log("\n161-A4 capacity exactly equals backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "a4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(countByState(h, "COMPLETED") === 5, "A4 all 5 done");
    ok(countByState(h, "PENDING") === 0, "A4 no pending");
  }

  console.log("\n161-A5 capacity larger than backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "a5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 100);
    ok(countByState(h, "COMPLETED") === 3, "A5 all done");
  }

  console.log("\n161-A6 zero capacity");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "a6-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 0);
    ok(countByState(h, "COMPLETED") === 0, "A6 nothing processed");
    ok(countByState(h, "PENDING") === 4, "A6 all pending");
  }

  console.log("\n161-A7 repeated bounded ticks");
  {
    const h = makeHarness();
    for (let i = 0; i < 15; i++) seedFinalizableOp(h, "a7-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    for (let tick = 0; tick < 5; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 15, "A7 all drained");
    ok(countByState(h, "PENDING") === 0, "A7 no pending");
  }

  // ================================================================
  // Group B — Work conservation (6)
  // ================================================================

  console.log("\n161-B1 unprocessed operations remain durable");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "b1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "PENDING") === 3, "B1 3 remain pending");
  }

  console.log("\n161-B2 next tick discovers previous backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "b2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const after1 = countByState(h, "PENDING");
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const after2 = countByState(h, "PENDING");
    ok(after2 === after1 - 2, "B2 drained by 2 more");
  }

  console.log("\n161-B3 no operation disappears because of capacity");
  {
    const h = makeHarness();
    for (let i = 0; i < 8; i++) seedFinalizableOp(h, "b3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countOps(h) === 8, "B3 all 8 rows present");
  }

  console.log("\n161-B4 no operation silently skipped permanently");
  {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) seedFinalizableOp(h, "b4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    for (let tick = 0; tick < 6; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    ok(countByState(h, "COMPLETED") === 6, "B4 all eventually completed");
  }

  console.log("\n161-B5 operation identity unchanged");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "b5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const beforeIds = ids.map((id) => getOp(h, id).operation_id);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const afterIds = ids.map((id) => getOp(h, id).operation_id);
    ok(JSON.stringify(beforeIds) === JSON.stringify(afterIds), "B5 ids stable");
  }

  console.log("\n161-B6 idempotency key unchanged");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "b6-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const beforeKeys = ids.map((id) => getOp(h, id).idempotency_key);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const afterKeys = ids.map((id) => getOp(h, id).idempotency_key);
    ok(JSON.stringify(beforeKeys) === JSON.stringify(afterKeys), "B6 keys stable");
  }

  // ================================================================
  // Group C — Multi-worker concurrency (8)
  // ================================================================

  console.log("161-C1 two engines process same backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) seedFinalizableOp(h, "c1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 6);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 6);
    ok(countByState(h, "COMPLETED") === 6, "C1 all completed");
    ok(countByState(h, "PENDING") === 0, "C1 no pending");
  }

  console.log("\n161-C2 three engines process same backlog");
  {
    const h = makeHarness();
    for (let i = 0; i < 9; i++) seedFinalizableOp(h, "c2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineC.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 9, "C2 all completed");
  }

  console.log("\n161-C3 overlapping reconciliation");
  {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) seedFinalizableOp(h, "c3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    // Each engine runs with the same large cap; overlap on every op candidate.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 6);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 6);
    h.engineC.reconcileExecutionRecoveryOperations(Date.now(), 6);
    ok(countByState(h, "COMPLETED") === 6, "C3 all completed");
    ok(countOps(h) === 6, "C3 no duplicates");
  }

  console.log("\n161-C4 concurrent claim attempts");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    const r1 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    const r2 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(r1.claimed === true && r2.claimed === false, "C4 exactly one claimer");
  }

  console.log("\n161-C5 exactly one owner at a time");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    ok(getOp(h, operation.operationId).claim_owner === "A", "C5 owner is A");
  }

  console.log("\n161-C6 no duplicate terminalization");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c6"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='c6'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION",
    });
    const r1 = h.store.recoveryOps.finalizeCompletedOperation(operation.operationId, Date.now());
    const r2 = h.store.recoveryOps.finalizeCompletedOperation(operation.operationId, Date.now());
    ok(r1 === true, "C6 first finalize applied");
    ok(r2 === false, "C6 second finalize no-op");
  }

  console.log("\n161-C7 no duplicate operation rows");
  {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) seedFinalizableOp(h, "c7-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(countOps(h) === 10, "C7 exactly 10 ops");
  }

  console.log("\n161-C8 stale worker cannot mutate after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    h.store.createJob(queuedJob("c8"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c8", leaseId: "L8", workerId: "w8", operationType: "CANCELLATION", now: t,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000, now: t + 1000 });
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "A", t + 2000) === false, "C8 stale A rejected");
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "B", t + 2000) === true, "C8 B applied");
  }

  // ================================================================
  // Group D — Capacity + concurrency (5)
  // ================================================================

  console.log("161-D1 per-call capacity bound holds under multiple engines");
  {
    const h = makeHarness();
    for (let i = 0; i < 9; i++) seedFinalizableOp(h, "d1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    // Each engine capped at 2 per call.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "D1 A processed 2");
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 4, "D1 B processed 2 more");
    h.engineC.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 6, "D1 C processed 2 more");
  }

  console.log("\n161-D2 no global capacity across engines (documented)");
  {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) seedFinalizableOp(h, "d2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    // Two engines each with limit=3: combined 6 processed.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 6, "D2 no global cap — each engine processes its own batch");
  }

  console.log("\n161-D3 capacity is per-call, not per-worker (proven)");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "d3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    // Same engine, two calls: 2 + 2 = 4 processed.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 4, "D3 same engine can call repeatedly");
  }

  console.log("\n161-D4 claimed operations do not cause permanent starvation");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    // Stale CLAIMED op from long ago.
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "stale", durationMs: 1, now: 1_000_000_000_000 });
    // Job already CANCELLED so reconcile can finalize.
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='d4'").run();
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "D4 stale claim taken over and completed");
  }

  console.log("\n161-D5 expired claims become recoverable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "stale", durationMs: 1, now: 1_000_000_000_000 });
    const r = h.store.recoveryOps.claimOperation({
      operationId: operation.operationId, owner: "fresh", durationMs: 60000, now: Date.now(),
    });
    ok(r.claimed === true, "D5 fresh can claim expired");
  }

  // ================================================================
  // Group E — Failure/retry (5)
  // ================================================================

  console.log("161-E1 retryable failure remains durable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(operation.operationId, "A", "transient");
    ok(getOp(h, operation.operationId).state === "FAILED", "E1 FAILED durable");
    ok(getOp(h, operation.operationId).last_error === "transient", "E1 error durable");
  }

  console.log("\n161-E2 retry budget preserved");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(operation.operationId, "A", "err");
    ok(getOp(h, operation.operationId).attempt_count === 1, "E2 attempt_count 1");
  }

  console.log("\n161-E3 exhausted retry escalates correctly");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5, last_error='orig' WHERE operation_id=?").run(operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "RECOVERY_REQUIRED", "E3 escalated");
    ok(getOp(h, operation.operationId).last_error.startsWith("MAX_RECOVERY_ATTEMPTS_EXCEEDED_5"), "E3 diagnostic");
  }

  console.log("\n161-E4 failed operation does not monopolize capacity");
  {
    const h = makeHarness();
    // Seed a FAILED-at-5 op (will escalate) plus 3 finalizable CANCELLATIONs.
    h.store.createJob(queuedJob("e4-failed"));
    const { operation: failOp } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e4-failed", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5 WHERE operation_id=?").run(failOp.operationId);
    const finalizables: string[] = [];
    for (let i = 0; i < 3; i++) finalizables.push(seedFinalizableOp(h, "e4-late-" + i, "CANCELLATION", 1_000_000_001_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    for (const id of finalizables) ok(getOp(h, id).state === "COMPLETED", "E4 finalizable completed");
  }

  console.log("\n161-E5 repeated ticks converge");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "e5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 2);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 5, "E5 all done");
    ok(countOps(h) === 5, "E5 no dup");
  }

  // ================================================================
  // Group F — Mixed operation types (4)
  // ================================================================

  console.log("161-F1 all three types processed under bounded capacity");
  {
    const h = makeHarness();
    const types = ["CANCELLATION", "TIMEOUT", "ORPHAN_RECOVERY"];
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(seedFinalizableOp(h, "f1-" + i, types[i % 3], 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 6);
    for (const id of ids) ok(getOp(h, id).state === "COMPLETED", "F1 completed");
  }

  console.log("\n161-F2 type does not affect capacity accounting");
  {
    const h = makeHarness();
    seedFinalizableOp(h, "f2-c", "CANCELLATION", 1_000_000_000_000);
    seedFinalizableOp(h, "f2-t", "TIMEOUT", 1_000_000_001_000);
    seedFinalizableOp(h, "f2-o", "ORPHAN_RECOVERY", 1_000_000_002_000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "F2 exactly 2 processed regardless of type");
  }

  console.log("\n161-F3 type does not affect ownership semantics");
  {
    const h = makeHarness();
    const types = ["CANCELLATION", "TIMEOUT", "ORPHAN_RECOVERY"];
    for (let i = 0; i < 3; i++) {
      h.store.createJob(queuedJob("f3-" + i));
      const { operation } = h.store.recoveryOps.createOrGetOperation({
        jobId: "f3-" + i, leaseId: "L3-" + i, workerId: "w3-" + i,
        operationType: types[i] as any,
      });
      const r = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
      ok(r.claimed === true, "F3 " + types[i] + " claimed");
      ok(getOp(h, operation.operationId).claim_owner === "A", "F3 " + types[i] + " owner A");
    }
  }

  console.log("\n161-F4 mixed backlog drains completely");
  {
    const h = makeHarness();
    const types = ["CANCELLATION", "TIMEOUT", "ORPHAN_RECOVERY"];
    for (let i = 0; i < 9; i++) seedFinalizableOp(h, "f4-" + i, types[i % 3], 1_000_000_000_000 + i * 1000);
    for (let tick = 0; tick < 3; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 9, "F4 all 9 done");
  }

  // ================================================================
  // Group G — Restart (5)
  // ================================================================

  console.log("161-G1 backlog survives database reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 5; i++) seedFinalizableOp(h1, "g1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      h1.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
      const pending1 = countByState(h1, "PENDING");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(countByState(h2, "PENDING") === pending1, "G1 pending count durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n161-G2 claimed/expired work follows existing lease rules");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("g2"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "g2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION", now: 1_000_000_000_000,
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1, now: 1_000_000_000_000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      // Expired claim can be taken over.
      const r = h2.store.recoveryOps.claimOperation({
        operationId: operation.operationId, owner: "B", durationMs: 60000, now: Date.now(),
      });
      ok(r.claimed === true, "G2 expired claim taken over after reopen");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n161-G3 restart does not duplicate operations");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 4; i++) seedFinalizableOp(h1, "g3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(countOps(h2) === 4, "G3 exactly 4 ops after reopen");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n161-G4 restart preserves order");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 5; i++) seedFinalizableOp(h1, "g4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      const before = resumableIds(h1);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const after = resumableIds(h2);
      ok(JSON.stringify(before) === JSON.stringify(after), "G4 order preserved");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n161-G5 backlog eventually drains after restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 6; i++) seedFinalizableOp(h1, "g5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      h1.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      for (let tick = 0; tick < 5; tick++) h2.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
      ok(countByState(h2, "COMPLETED") === 6, "G5 all drained");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group H — Shutdown (4)
  // ================================================================

  console.log("161-H1 shutdown blocks new reconciliation");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "h1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.shutdown();
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countByState(h, "COMPLETED") === 0, "H1 nothing processed");
  }

  console.log("\n161-H2 pending work remains durable");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "h2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.shutdown();
    ok(countByState(h, "PENDING") === 4, "H2 all pending durable");
    ok(countOps(h) === 4, "H2 op count unchanged");
  }

  console.log("\n161-H3 restart can process remaining work");
  {
    const dir = mkdtempSync(join(tmpdir(), "p161-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h1, "h3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
      h1.engineA.shutdown();
      h1.db.close();
      const h2 = makeHarness(dbFile);
      for (let tick = 0; tick < 5; tick++) h2.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
      ok(countByState(h2, "COMPLETED") === 5, "H3 drained after restart");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n161-H4 shutdown does not create terminal states");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "h4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.shutdown();
    h.engineB.shutdown();
    h.engineC.shutdown();
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engineC.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countByState(h, "COMPLETED") === 0, "H4 nothing completed");
    ok(countByState(h, "PENDING") === 3, "H4 all pending");
  }

  // ================================================================
  // Group I — Terminal fencing (5)
  // ================================================================

  console.log("161-I1 COMPLETED not resurrectable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i1"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i1'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.finalizeCompletedOperation(operation.operationId, Date.now());
    for (let i = 0; i < 5; i++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "I1 still COMPLETED");
  }

  console.log("\n161-I2 FAILED not resurrectable by reconcile");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markFailed(operation.operationId, "A", "err");
    // Reconcile may retry, but the op should never appear as resurrected from terminal.
    // We don't assert it stays FAILED (reconcile legitimately retries failed ops per Phase 145).
    // We assert it doesn't become COMPLETED without a fresh claim cycle.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    const st = getOp(h, operation.operationId).state;
    ok(st !== "COMPLETED" || getOp(h, operation.operationId).attempt_count >= 2, "I2 no false completion without claim");
  }

  console.log("\n161-I3 CANCELLED not resurrectable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "A" });
    for (let i = 0; i < 5; i++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "CANCELLED", "I3 still CANCELLED");
  }

  console.log("\n161-I4 RECOVERY_REQUIRED not resurrectable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "err");
    for (let i = 0; i < 5; i++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "RECOVERY_REQUIRED", "I4 still RECOVERY_REQUIRED");
  }

  console.log("\n161-I5 terminal states excluded from resumable set");
  {
    const h = makeHarness();
    const terminals: string[] = [];
    // COMPLETED
    h.store.createJob(queuedJob("i5-c"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i5-c'").run();
    const opC = h.store.recoveryOps.createOrGetOperation({ jobId: "i5-c", leaseId: "L5c", workerId: "w5c", operationType: "CANCELLATION" });
    h.store.recoveryOps.finalizeCompletedOperation(opC.operation.operationId, Date.now());
    terminals.push(opC.operation.operationId);
    // CANCELLED
    h.store.createJob(queuedJob("i5-x"));
    const opX = h.store.recoveryOps.createOrGetOperation({ jobId: "i5-x", leaseId: "L5x", workerId: "w5x", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: opX.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: opX.operation.operationId, owner: "A" });
    terminals.push(opX.operation.operationId);
    // RECOVERY_REQUIRED
    h.store.createJob(queuedJob("i5-r"));
    const opR = h.store.recoveryOps.createOrGetOperation({ jobId: "i5-r", leaseId: "L5r", workerId: "w5r", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: opR.operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(opR.operation.operationId, "A", "err");
    terminals.push(opR.operation.operationId);
    const res = resumableIds(h);
    for (const id of terminals) ok(!res.includes(id), "I5 terminal excluded: " + id);
  }

  // ================================================================
  // Group J — Observability / event integrity (4)
  // ================================================================

  console.log("161-J1 scheduler activity does not create duplicate operations");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "j1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    const before = countOps(h);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 5);
    h.engineC.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(countOps(h) === before, "J1 op count unchanged");
  }

  console.log("\n161-J2 no duplicate terminal events");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(seedFinalizableOp(h, "j2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    for (const id of ids) {
      const jobId = getOp(h, id).job_id;
      // Finalize-only path does not write events.
      ok(countEvents(h, jobId) === 0, "J2 no events for " + jobId);
    }
  }

  console.log("\n161-J3 no synthetic success events");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "j3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const synthetic = h.db.prepare(
      "SELECT COUNT(*) AS n FROM execution_events WHERE event_type LIKE '%success%' OR event_type LIKE '%recovered%'"
    ).get() as any;
    ok(synthetic.n === 0, "J3 no synthetic success events");
  }

  console.log("\n161-J4 no event spam from repeated bounded ticks");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "j4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    for (let tick = 0; tick < 10; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    const total = h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id LIKE 'j4-%'").get() as any;
    ok(total.n === 0, "J4 zero events after 10 ticks");
  }

  console.log("\n--- Phase 161: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE161 DRIVER CRASH:", err); process.exit(1); });
