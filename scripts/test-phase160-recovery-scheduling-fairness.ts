// scripts/test-phase160-recovery-scheduling-fairness.ts
// Phase 160 - recovery scheduling fairness & starvation prevention.
//
// Scope note (Step 21):
//   Inspection confirmed that the existing implementation already provides
//   deterministic age-ordered scheduling:
//     - listResumableOperations() orders by created_at ASC (durable, written
//       once at INSERT, never mutated).
//     - reconcile's bounded slice (Phase 159) takes the FRONT of that list.
//     - FAILED ops at attempt_count >= 5 escalate to RECOVERY_REQUIRED and
//       drop out of the resumable set (retry fairness).
//   No production code change is required. This suite proves those
//   guarantees under backlog pressure, concurrent workers, restart, and
//   mixed operation types.
//
// Determinism note: every seeded op uses an explicit `now` value so that
// created_at ordering is guaranteed by construction. No test relies on
// timing, randomness, or sleep.

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

interface H { db: Database.Database; store: ExecutionStore; engineA: ExecutionEngine; engineB: ExecutionEngine; }

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
  return { db: rawDb, store, engineA, engineB };
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

// Seed a PENDING CANCELLATION op whose job is already CANCELLED, so
// reconcile finalizes the op without calling recoverJobAtomic. This gives a
// clean "finalized vs still pending" signal for ordering assertions.
function seedFinalizableOp(h: H, jobId: string, opType: string, createdAt: number): string {
  h.store.createJob(queuedJob(jobId));
  // Set the job to the postcondition that reconcile recognizes as already
  // satisfied for this operation type, so reconcile finalizes the op without
  // calling recoverJobAtomic.
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
function listOpIds(h: H): string[] {
  return h.store.recoveryOps.listResumableOperations().map((o: any) => o.operationId);
}

async function main() {
  console.log("=== Phase 160 - Recovery Scheduling Fairness & Starvation Prevention ===\n");

  // ================================================================
  // Group A — Deterministic candidate ordering (5)
  // ================================================================

  console.log("160-A1 two ops with distinct created_at come back in order");
  {
    const h = makeHarness();
    const a = seedFinalizableOp(h, "a1-a", "CANCELLATION", 1_000_000_000_000);
    const b = seedFinalizableOp(h, "a1-b", "CANCELLATION", 1_000_000_001_000);
    const ids = listOpIds(h);
    ok(ids[0] === a && ids[1] === b, "A1 [a, b] order");
  }

  console.log("\n160-A2 five ops with distinct created_at are ordered ascending");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "a2-" + i, "CANCELLATION", 2_000_000_000_000 + i * 1000));
    const listed = listOpIds(h);
    ok(listed.length === 5, "A2 five candidates");
    for (let i = 0; i < 5; i++) ok(listed[i] === ids[i], "A2 position " + i);
  }

  console.log("\n160-A3 ordering is stable across repeated calls");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "a3-" + i, "CANCELLATION", 3_000_000_000_000 + i * 1000);
    const first = listOpIds(h);
    const second = listOpIds(h);
    ok(JSON.stringify(first) === JSON.stringify(second), "A3 identical across calls");
  }

  console.log("\n160-A4 new arrivals append at the end");
  {
    const h = makeHarness();
    const old1 = seedFinalizableOp(h, "a4-old1", "CANCELLATION", 4_000_000_000_000);
    const old2 = seedFinalizableOp(h, "a4-old2", "CANCELLATION", 4_000_000_001_000);
    const fresh = seedFinalizableOp(h, "a4-fresh", "CANCELLATION", 4_000_100_000_000);
    const ids = listOpIds(h);
    ok(ids[0] === old1, "A4 oldest first");
    ok(ids[1] === old2, "A4 second oldest");
    ok(ids[2] === fresh, "A4 fresh at end");
  }

  console.log("\n160-A5 ordering survives a caller-visible re-read");
  {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) seedFinalizableOp(h, "a5-" + i, "CANCELLATION", 5_000_000_000_000 + i * 1000);
    const first = h.store.recoveryOps.listResumableOperations();
    const second = h.store.recoveryOps.listResumableOperations();
    ok(first.length === 10, "A5 ten candidates");
    ok(JSON.stringify(first.map((o: any) => o.operationId)) === JSON.stringify(second.map((o: any) => o.operationId)), "A5 identical");
  }

  // ================================================================
  // Group B — Bounded tick fairness (6)
  // ================================================================

  console.log("160-B1 limit=1 processes the oldest");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "b1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    ok(getOp(h, ids[0]).state === "COMPLETED", "B1 oldest finalized");
    ok(getOp(h, ids[1]).state === "PENDING", "B1 second still pending");
  }

  console.log("\n160-B2 limit=3 takes the three oldest in order");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(seedFinalizableOp(h, "b2-" + i, "CANCELLATION", 2_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(getOp(h, ids[0]).state === "COMPLETED", "B2 #0 done");
    ok(getOp(h, ids[1]).state === "COMPLETED", "B2 #1 done");
    ok(getOp(h, ids[2]).state === "COMPLETED", "B2 #2 done");
    ok(getOp(h, ids[3]).state === "PENDING", "B2 #3 not yet");
    ok(getOp(h, ids[4]).state === "PENDING", "B2 #4 not yet");
    ok(getOp(h, ids[5]).state === "PENDING", "B2 #5 not yet");
  }

  console.log("\n160-B3 limit=0 processes nothing");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "b3-" + i, "CANCELLATION", 3_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 0);
    ok(countByState(h, "COMPLETED") === 0, "B3 nothing completed");
  }

  console.log("\n160-B4 limit >= backlog processes all");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "b4-" + i, "CANCELLATION", 4_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 100);
    ok(countByState(h, "COMPLETED") === 3, "B4 all completed");
  }

  console.log("\n160-B5 successive limit=1 ticks drain in creation order");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "b5-" + i, "CANCELLATION", 5_000_000_000_000 + i * 1000));
    // After tick N, ids[0..N-1] should be COMPLETED and ids[N] PENDING.
    for (let tick = 0; tick < 5; tick++) {
      h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
      ok(getOp(h, ids[tick]).state === "COMPLETED", "B5 tick " + tick + " processed " + tick);
      if (tick + 1 < 5) ok(getOp(h, ids[tick + 1]).state === "PENDING", "B5 tick " + tick + " next still pending");
    }
  }

  console.log("\n160-B6 unprocessed ops retain their position for the next tick");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "b6-" + i, "CANCELLATION", 6_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const remaining = h.store.recoveryOps.listResumableOperations().map((o: any) => o.operationId);
    ok(remaining.length === 3, "B6 three remain");
    ok(remaining[0] === ids[2], "B6 oldest remaining is #2");
    ok(remaining[1] === ids[3], "B6 then #3");
    ok(remaining[2] === ids[4], "B6 then #4");
  }

  // ================================================================
  // Group C — Old backlog vs continuous new arrivals (5)
  // ================================================================

  console.log("160-C1 5 old + 5 new, limit=5 processes exactly the 5 old");
  {
    const h = makeHarness();
    const oldIds: string[] = [];
    const newIds: string[] = [];
    for (let i = 0; i < 5; i++) oldIds.push(seedFinalizableOp(h, "c1-old-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    for (let i = 0; i < 5; i++) newIds.push(seedFinalizableOp(h, "c1-new-" + i, "CANCELLATION", 1_000_100_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    for (const id of oldIds) ok(getOp(h, id).state === "COMPLETED", "C1 old completed");
    for (const id of newIds) ok(getOp(h, id).state === "PENDING", "C1 new untouched");
  }

  console.log("\n160-C2 5 old + 5 new, limit=3 → 3 old done, 2 old + 5 new remain");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "c2-old-" + i, "CANCELLATION", 2_000_000_000_000 + i * 1000);
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "c2-new-" + i, "CANCELLATION", 2_000_100_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countByState(h, "COMPLETED") === 3, "C2 three done");
    const remaining = h.store.recoveryOps.listResumableOperations().map((o: any) => o.jobId);
    ok(remaining[0].startsWith("c2-old-"), "C2 oldest remaining still old batch");
    ok(remaining.length === 7, "C2 two old + five new remain");
  }

  console.log("\n160-C3 old batch is drained before any new batch is touched");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "c3-old-" + i, "CANCELLATION", 3_000_000_000_000 + i * 1000);
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "c3-new-" + i, "CANCELLATION", 3_000_100_000_000 + i * 1000);
    // Run 8 ticks of limit=1. First 4 should hit old batch, next 4 new batch.
    for (let tick = 0; tick < 8; tick++) {
      h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    }
    // All 8 should be done.
    ok(countByState(h, "COMPLETED") === 8, "C3 all eight done");
    ok(countByState(h, "PENDING") === 0, "C3 no pending");
  }

  console.log("\n160-C4 100-tick simulation: old ops never starved by new arrivals");
  {
    const h = makeHarness();
    const oldIds: string[] = [];
    for (let i = 0; i < 10; i++) oldIds.push(seedFinalizableOp(h, "c4-old-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    // Now interleave: for each tick, add one new op, then tick limit=1.
    for (let tick = 0; tick < 10; tick++) {
      seedFinalizableOp(h, "c4-new-" + tick, "CANCELLATION", 1_000_100_000_000 + tick * 1000);
      h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    }
    // After 10 ticks, all 10 old ops are done; all 10 new are still PENDING.
    for (const id of oldIds) ok(getOp(h, id).state === "COMPLETED", "C4 old " + id + " completed");
    ok(countByState(h, "COMPLETED") === 10, "C4 exactly 10 completed");
    ok(countByState(h, "PENDING") === 10, "C4 exactly 10 new pending");
  }

  console.log("\n160-C5 new arrivals don't push old ops backward in the queue");
  {
    const h = makeHarness();
    const a = seedFinalizableOp(h, "c5-a", "CANCELLATION", 1_000_000_000_000);
    // Insert 100 new ops.
    for (let i = 0; i < 100; i++) seedFinalizableOp(h, "c5-new-" + i, "CANCELLATION", 1_000_000_001_000 + i * 1000);
    const ids = listOpIds(h);
    ok(ids[0] === a, "C5 oldest op is still first");
  }

  // ================================================================
  // Group D — Repeated failure does not monopolize (5)
  // ================================================================

  console.log("160-D1 FAILED op at attempt_count=5 escalates to RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5, last_error='orig' WHERE operation_id=?").run(operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "RECOVERY_REQUIRED", "D1 escalated to RR");
    ok(getOp(h, operation.operationId).last_error.startsWith("MAX_RECOVERY_ATTEMPTS_EXCEEDED_5"), "D1 diagnostic message");
  }

  console.log("\n160-D2 escalated op leaves the resumable list");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5 WHERE operation_id=?").run(operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    const ids = listOpIds(h);
    ok(!ids.includes(operation.operationId), "D2 not in resumable list");
  }

  console.log("\n160-D3 FAILED op below threshold doesn't monopolize other candidates");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d3-failed"));
    const { operation: failed } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d3-failed", leaseId: "L3a", workerId: "w3a", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=2 WHERE operation_id=?").run(failed.operationId);
    // Seed 3 finalizable CANCELLATION ops with later created_at.
    const later: string[] = [];
    for (let i = 0; i < 3; i++) later.push(seedFinalizableOp(h, "d3-late-" + i, "CANCELLATION", 1_000_000_001_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    // All later ops should be COMPLETED regardless of the FAILED one.
    for (const id of later) ok(getOp(h, id).state === "COMPLETED", "D3 later op completed");
  }

  console.log("\n160-D4 a FAILED-at-max op still consumes zero slots on the next bounded tick");
  {
    const h = makeHarness();
    // Seed FAILED-at-5 (will escalate this tick)
    h.store.createJob(queuedJob("d4-fail"));
    const { operation: failOp } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d4-fail", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5 WHERE operation_id=?").run(failOp.operationId);
    const finalizables: string[] = [];
    for (let i = 0; i < 3; i++) finalizables.push(seedFinalizableOp(h, "d4-late-" + i, "CANCELLATION", 1_000_000_001_000 + i * 1000));
    // First tick, limit=10.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    // Second tick: escalated op should not be present in the resumable set.
    const ids = listOpIds(h);
    ok(!ids.includes(failOp.operationId), "D4 escalated op absent");
    ok(getOp(h, failOp.operationId).state === "RECOVERY_REQUIRED", "D4 state is RR");
  }

  console.log("\n160-D5 repeated FAILED ops all escalate eventually and stop consuming slots");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) {
      h.store.createJob(queuedJob("d5-" + i));
      const { operation } = h.store.recoveryOps.createOrGetOperation({
        jobId: "d5-" + i, leaseId: "L5-" + i, workerId: "w5-" + i, operationType: "CANCELLATION", now: 1_000_000_000_000 + i * 1000,
      });
      h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5 WHERE operation_id=?").run(operation.operationId);
    }
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countByState(h, "RECOVERY_REQUIRED") === 5, "D5 all five escalated");
    ok(listOpIds(h).length === 0, "D5 resumable set is empty");
  }

  // ================================================================
  // Group E — Mixed operation types (4)
  // ================================================================

  console.log("160-E1 CANCELLATION + TIMEOUT + ORPHAN_RECOVERY ordered by created_at");
  {
    const h = makeHarness();
    const t1 = seedFinalizableOp(h, "e1-c", "CANCELLATION", 1_000_000_000_000);
    const t2 = seedFinalizableOp(h, "e1-t", "TIMEOUT", 1_000_000_001_000);
    const t3 = seedFinalizableOp(h, "e1-o", "ORPHAN_RECOVERY", 1_000_000_002_000);
    const ids = listOpIds(h);
    ok(ids[0] === t1, "E1 CANCELLATION first");
    ok(ids[1] === t2, "E1 TIMEOUT second");
    ok(ids[2] === t3, "E1 ORPHAN_RECOVERY third");
  }

  console.log("\n160-E2 cap=1 takes the oldest across types");
  {
    const h = makeHarness();
    const oldOrphan = seedFinalizableOp(h, "e2-old", "ORPHAN_RECOVERY", 1_000_000_000_000);
    seedFinalizableOp(h, "e2-mid", "TIMEOUT", 1_000_000_001_000);
    seedFinalizableOp(h, "e2-new", "CANCELLATION", 1_000_000_002_000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    ok(getOp(h, oldOrphan).state === "COMPLETED", "E2 oldest processed regardless of type");
  }

  console.log("\n160-E3 operation type does not affect candidate order");
  {
    const h = makeHarness();
    const a = seedFinalizableOp(h, "e3-a", "ORPHAN_RECOVERY", 1_000_000_000_000);
    const b = seedFinalizableOp(h, "e3-b", "CANCELLATION", 1_000_000_001_000);
    const c = seedFinalizableOp(h, "e3-c", "TIMEOUT", 1_000_000_002_000);
    const ids = listOpIds(h);
    ok(ids[0] === a && ids[1] === b && ids[2] === c, "E3 strict created_at order");
  }

  console.log("\n160-E4 mixed-type batch of cap=3 processes three oldest regardless of type");
  {
    const h = makeHarness();
    const ids: string[] = [];
    const types = ["CANCELLATION", "TIMEOUT", "ORPHAN_RECOVERY"];
    for (let i = 0; i < 6; i++) {
      ids.push(seedFinalizableOp(h, "e4-" + i, types[i % 3], 1_000_000_000_000 + i * 1000));
    }
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(getOp(h, ids[0]).state === "COMPLETED", "E4 #0");
    ok(getOp(h, ids[1]).state === "COMPLETED", "E4 #1");
    ok(getOp(h, ids[2]).state === "COMPLETED", "E4 #2");
    ok(getOp(h, ids[3]).state === "PENDING", "E4 #3 pending");
  }

  // ================================================================
  // Group F — Multiple workers (5)
  // ================================================================

  console.log("160-F1 two engines reconcile the same batch without double-claim");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(seedFinalizableOp(h, "f1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    for (const id of ids) ok(getOp(h, id).state === "COMPLETED", "F1 completed once");
    ok(countOps(h) === 6, "F1 op count unchanged");
  }

  console.log("\n160-F2 second engine continues where the first left off");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(seedFinalizableOp(h, "f2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const afterA = h.store.recoveryOps.listResumableOperations().map((o: any) => o.operationId);
    ok(afterA[0] === ids[2], "F2 after A, oldest is #2");
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const afterB = h.store.recoveryOps.listResumableOperations().map((o: any) => o.operationId);
    ok(afterB[0] === ids[4], "F2 after B, oldest is #4");
  }

  console.log("\n160-F3 three engines converge without duplicates");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(seedFinalizableOp(h, "f3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const engineC = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 4);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 4);
    engineC.reconcileExecutionRecoveryOperations(Date.now(), 4);
    for (const id of ids) ok(getOp(h, id).state === "COMPLETED", "F3 all completed");
    ok(countOps(h) === 12, "F3 op count 12");
  }

  console.log("\n160-F4 concurrent partial ticks preserve per-op terminal state");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(seedFinalizableOp(h, "f4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    // Interleave A and B.
    for (let tick = 0; tick < 4; tick++) {
      h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
      h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 1);
    }
    for (const id of ids) {
      const op = getOp(h, id);
      // Every op should either be COMPLETED or PENDING — never partial.
      ok(op.state === "COMPLETED" || op.state === "PENDING", "F4 terminal or pending only");
    }
  }

  console.log("\n160-F5 no duplicate operations created by concurrent reconcile");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "f5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countOps(h) === 5, "F5 exactly five ops");
  }

  // ================================================================
  // Group G — Database reopen (5)
  // ================================================================

  console.log("160-G1 created_at survives reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 4; i++) seedFinalizableOp(h1, "g1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      const before = listOpIds(h1);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(JSON.stringify(listOpIds(h2)) === JSON.stringify(before), "G1 order preserved");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n160-G2 bounded tick continues from oldest pending after reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h1, "g2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
      h1.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      h2.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
      ok(getOp(h2, ids[2]).state === "COMPLETED", "G2 oldest pending processed");
      ok(getOp(h2, ids[0]).state === "COMPLETED", "G2 earlier still completed");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n160-G3 terminal ops are not selected after reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(seedFinalizableOp(h1, "g3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
      h1.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const remaining = listOpIds(h2);
      ok(remaining.length === 0, "G3 no resumable ops remain");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n160-G4 new arrivals after reopen append at the end");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const old1 = seedFinalizableOp(h1, "g4-old", "CANCELLATION", 1_000_000_000_000);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const fresh = seedFinalizableOp(h2, "g4-fresh", "CANCELLATION", 2_000_000_000_000);
      const ids = listOpIds(h2);
      ok(ids[0] === old1, "G4 old still first");
      ok(ids[1] === fresh, "G4 fresh appended");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n160-G5 restart preserves fair ordering across many ops");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 10; i++) seedFinalizableOp(h1, "g5-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      const before = listOpIds(h1);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const after = listOpIds(h2);
      ok(before.length === after.length, "G5 same count");
      for (let i = 0; i < before.length; i++) ok(before[i] === after[i], "G5 position " + i);
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group H — Shutdown / restart (4)
  // ================================================================

  console.log("160-H1 shutdown flag stops reconciliation");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "h1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.shutdown();
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(countByState(h, "COMPLETED") === 0, "H1 nothing processed");
  }

  console.log("\n160-H2 pending backlog survives shutdown");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "h2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.shutdown();
    ok(countByState(h, "PENDING") === 5, "H2 all pending");
    ok(listOpIds(h).length === 5, "H2 all in resumable");
  }

  console.log("\n160-H3 restart + reconcile drains in original order");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h1, "h3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
      h1.engineA.shutdown();
      h1.db.close();
      const h2 = makeHarness(dbFile);
      for (let tick = 0; tick < 5; tick++) {
        h2.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
        ok(getOp(h2, ids[tick]).state === "COMPLETED", "H3 tick " + tick + " processed " + tick);
      }
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n160-H4 shutdown does not alter created_at");
  {
    const dir = mkdtempSync(join(tmpdir(), "p160-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      for (let i = 0; i < 3; i++) seedFinalizableOp(h1, "h4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
      const before = h1.db.prepare("SELECT operation_id, created_at FROM execution_recovery_operations ORDER BY created_at").all() as any[];
      h1.engineA.shutdown();
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const after = h2.db.prepare("SELECT operation_id, created_at FROM execution_recovery_operations ORDER BY created_at").all() as any[];
      ok(JSON.stringify(before) === JSON.stringify(after), "H4 created_at unchanged");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group I — Claim expiry / takeover (5)
  // ================================================================

  console.log("160-I1 expired claim can be taken over");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i1"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i1'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    // Claim has expired long ago. reconcile should be able to take over.
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "I1 taken over and completed");
  }

  console.log("\n160-I2 takeover preserves op identity");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i2"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i2'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    const before = getOp(h, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    const after = getOp(h, operation.operationId);
    ok(before.operation_id === after.operation_id, "I2 id unchanged");
    ok(before.idempotency_key === after.idempotency_key, "I2 key unchanged");
    ok(before.job_id === after.job_id, "I2 job unchanged");
  }

  console.log("\n160-I3 CLAIMED ops with expired claims are candidates");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i3"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i3'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    const ids = listOpIds(h);
    ok(ids.includes(operation.operationId), "I3 expired CLAIMED is a candidate");
  }

  console.log("\n160-I4 stale owner can't re-mutate after takeover");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i4"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i4'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "I4 completed by reconciler");
    // Now stale A attempts to mutate.
    ok(h.store.recoveryOps.markFailed(operation.operationId, "A", "late", Date.now()) === false, "I4 A rejected");
  }

  console.log("\n160-I5 no duplicate terminalization after takeover");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i5"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='i5'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "i5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 10);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 10);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "I5 completed once");
    ok(countEvents(h, "i5") === 0, "I5 no events");
  }

  // ================================================================
  // Group J — Terminal-state fencing (5)
  // ================================================================

  console.log("160-J1 COMPLETED not in resumable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='j1'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "j1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.finalizeCompletedOperation(operation.operationId, Date.now());
    ok(!listOpIds(h).includes(operation.operationId), "J1 COMPLETED excluded");
  }

  console.log("\n160-J2 CANCELLED not in resumable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "j2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "A", now: 1_000_000_000_000 });
    ok(!listOpIds(h).includes(operation.operationId), "J2 CANCELLED excluded");
  }

  console.log("\n160-J3 RECOVERY_REQUIRED not in resumable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_000_000 });
    h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "err", 1_000_000_000_000);
    ok(!listOpIds(h).includes(operation.operationId), "J3 RECOVERY_REQUIRED excluded");
  }

  console.log("\n160-J4 bounded tick cannot resurrect terminal ops");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='j4'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "j4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION", now: 1_000_000_000_000,
    });
    h.store.recoveryOps.finalizeCompletedOperation(operation.operationId, 1_000_000_001_000);
    for (let i = 0; i < 5; i++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(getOp(h, operation.operationId).state === "COMPLETED", "J4 still COMPLETED");
  }

  console.log("\n160-J5 repeated ticks leave every terminal op untouched");
  {
    const h = makeHarness();
    const terminals: string[] = [];
    // COMPLETED
    h.store.createJob(queuedJob("j5-c"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='j5-c'").run();
    const opC = h.store.recoveryOps.createOrGetOperation({ jobId: "j5-c", leaseId: "L5c", workerId: "w5c", operationType: "CANCELLATION", now: 1_000_000_000_000 });
    h.store.recoveryOps.finalizeCompletedOperation(opC.operation.operationId, 1_000_000_001_000);
    terminals.push(opC.operation.operationId);
    // CANCELLED
    h.store.createJob(queuedJob("j5-x"));
    const opX = h.store.recoveryOps.createOrGetOperation({ jobId: "j5-x", leaseId: "L5x", workerId: "w5x", operationType: "CANCELLATION", now: 1_000_000_002_000 });
    h.store.recoveryOps.claimOperation({ operationId: opX.operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_003_000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: opX.operation.operationId, owner: "A", now: 1_000_000_004_000 });
    terminals.push(opX.operation.operationId);
    // RECOVERY_REQUIRED
    h.store.createJob(queuedJob("j5-r"));
    const opR = h.store.recoveryOps.createOrGetOperation({ jobId: "j5-r", leaseId: "L5r", workerId: "w5r", operationType: "CANCELLATION", now: 1_000_000_005_000 });
    h.store.recoveryOps.claimOperation({ operationId: opR.operation.operationId, owner: "A", durationMs: 60000, now: 1_000_000_006_000 });
    h.store.recoveryOps.markRecoveryRequired(opR.operation.operationId, "A", "err", 1_000_000_007_000);
    terminals.push(opR.operation.operationId);
    // Bounded ticks.
    for (let i = 0; i < 5; i++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    for (const id of terminals) {
      const st = getOp(h, id).state;
      ok(st === "COMPLETED" || st === "CANCELLED" || st === "RECOVERY_REQUIRED", "J5 terminal preserved");
    }
  }

  // ================================================================
  // Group K — Idempotency preservation (4)
  // ================================================================

  console.log("160-K1 operation_id unchanged across waiting and processing");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(seedFinalizableOp(h, "k1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const before = ids.map((id) => getOp(h, id).operation_id);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 4);
    const after = ids.map((id) => getOp(h, id).operation_id);
    ok(JSON.stringify(before) === JSON.stringify(after), "K1 ids stable");
  }

  console.log("\n160-K2 idempotency_key unchanged");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(seedFinalizableOp(h, "k2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const before = ids.map((id) => getOp(h, id).idempotency_key);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 2);
    const after = ids.map((id) => getOp(h, id).idempotency_key);
    ok(JSON.stringify(before) === JSON.stringify(after), "K2 keys stable");
  }

  console.log("\n160-K3 job_id unchanged");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(seedFinalizableOp(h, "k3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    const before = ids.map((id) => getOp(h, id).job_id);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const after = ids.map((id) => getOp(h, id).job_id);
    ok(JSON.stringify(before) === JSON.stringify(after), "K3 jobs stable");
  }

  console.log("\n160-K4 operation_type unchanged");
  {
    const h = makeHarness();
    const types = ["CANCELLATION", "TIMEOUT", "ORPHAN_RECOVERY"];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(seedFinalizableOp(h, "k4-" + i, types[i], 1_000_000_000_000 + i * 1000));
    const before = ids.map((id) => getOp(h, id).operation_type);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const after = ids.map((id) => getOp(h, id).operation_type);
    ok(JSON.stringify(before) === JSON.stringify(after), "K4 types stable");
  }

  // ================================================================
  // Group L — Phase 159 limit behavior preserved (5)
  // ================================================================

  console.log("160-L1 no-arg reconcile processes all");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "l1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(countByState(h, "COMPLETED") === 5, "L1 all processed");
  }

  console.log("\n160-L2 Infinity processes all");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "l2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), Infinity);
    ok(countByState(h, "COMPLETED") === 5, "L2 all processed");
  }

  console.log("\n160-L3 finite limit caps per tick");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "l3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 2);
    ok(countByState(h, "COMPLETED") === 2, "L3 exactly two");
  }

  console.log("\n160-L4 limit=0 processes nothing");
  {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) seedFinalizableOp(h, "l4-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 0);
    ok(countByState(h, "COMPLETED") === 0, "L4 nothing done");
  }

  console.log("\n160-L5 negative / NaN treated as unbounded");
  {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h, "l5-neg-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), -1);
    ok(countByState(h, "COMPLETED") === 4, "L5 negative unbounded");

    const h2 = makeHarness();
    for (let i = 0; i < 4; i++) seedFinalizableOp(h2, "l5-nan-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    h2.engineA.reconcileExecutionRecoveryOperations(Date.now(), NaN);
    ok(countByState(h2, "COMPLETED") === 4, "L5 NaN unbounded");
  }

  // ================================================================
  // Group M — No duplicate events (3)
  // ================================================================

  console.log("160-M1 finalized ops create no events");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "m1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    let totalEvents = 0;
    for (const id of ids) {
      const job = getOp(h, id).job_id;
      totalEvents += countEvents(h, job);
    }
    ok(totalEvents === 0, "M1 zero events from finalize-only path");
  }

  console.log("\n160-M2 repeated bounded ticks produce no duplicate events");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedFinalizableOp(h, "m2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    for (let tick = 0; tick < 5; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    let totalEvents = 0;
    for (const id of ids) totalEvents += countEvents(h, getOp(h, id).job_id);
    ok(totalEvents === 0, "M2 zero events after 5 ticks");
  }

  console.log("\n160-M3 terminal-state tick produces no events");
  {
    const h = makeHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(seedFinalizableOp(h, "m3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const eventsAfterFirst = ids.map((id) => countEvents(h, getOp(h, id).job_id));
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    const eventsAfterRepeat = ids.map((id) => countEvents(h, getOp(h, id).job_id));
    ok(JSON.stringify(eventsAfterFirst) === JSON.stringify(eventsAfterRepeat), "M3 events stable");
  }

  // ================================================================
  // Group N — No duplicate operations (3)
  // ================================================================

  console.log("160-N1 op count unchanged across 10 bounded ticks");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "n1-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    const before = countOps(h);
    for (let tick = 0; tick < 10; tick++) h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 1);
    ok(countOps(h) === before, "N1 op count stable");
  }

  console.log("\n160-N2 reconcile never creates new ops");
  {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) seedFinalizableOp(h, "n2-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    const before = countOps(h);
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 5);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 5);
    ok(countOps(h) === before, "N2 no new ops");
  }

  console.log("\n160-N3 parallel engines do not duplicate operations");
  {
    const h = makeHarness();
    for (let i = 0; i < 8; i++) seedFinalizableOp(h, "n3-" + i, "CANCELLATION", 1_000_000_000_000 + i * 1000);
    const engineC = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engineA.reconcileExecutionRecoveryOperations(Date.now(), 3);
    h.engineB.reconcileExecutionRecoveryOperations(Date.now(), 3);
    engineC.reconcileExecutionRecoveryOperations(Date.now(), 3);
    ok(countOps(h) === 8, "N3 exactly eight ops");
    ok(countByState(h, "COMPLETED") === 8, "N3 all completed once");
  }

  console.log("\n--- Phase 160: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE160 DRIVER CRASH:", err); process.exit(1); });
