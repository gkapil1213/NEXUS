// scripts/test-phase152-recovery-concurrency.ts
// Phase 152 - durable recovery concurrency & exactly-once side-effect integrity.
//
// Exercises the real ExecutionStore / ExecutionRecoveryOperationStore /
// ExecutionEngine against real better-sqlite3. Two engine instances share one
// store to simulate concurrent reconcilers.
//
// Note on "concurrency": better-sqlite3 is synchronous. This suite serializes
// two owners' operations at the JS event-loop level and lets the DB-level CAS
// in claimOperation / mark* / recoverJobAtomic determine the winner. That is
// the same serialization discipline every prior phase test uses; the CAS
// predicates, not the JS interleaving, are the authoritative fence.
//
// Every assertion reads durable SQLite rows.

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
  return { db: rawDb, store, engineA, engineB };
}

function queuedJob(id: string, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
    ...extra,
  } as ExecutionJob;
}

function seedLease(db: Database.Database, jobId: string, workerId: string, leaseId: string, status = "ACTIVE", expiresAt = Date.now() + 60000): void {
  db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now() - 120000, expiresAt, status);
}
function setJobRunning(db: Database.Database, jobId: string, leaseId: string | null): void {
  db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
}
function insertAttempt(db: Database.Database, id: string, jobId: string, num: number, leaseId: string, workerId: string, startedAt: number): void {
  db.prepare(
    "INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, started_at, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, jobId, num, "RUNNING", workerId, leaseId, startedAt, Date.now());
}
function getJob(db: Database.Database, id: string) { return db.prepare("SELECT status, current_lease_id, next_attempt_at FROM execution_jobs WHERE id = ?").get(id) as any; }
function getOp(db: Database.Database, jobId: string, type: string) {
  return db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ? ORDER BY created_at DESC LIMIT 1").get(jobId, type) as any;
}
function countOpRows(db: Database.Database, jobId: string, type: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ?").get(jobId, type) as any).n;
}
function countEvents(db: Database.Database, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type ? (db.prepare(sql).get(jobId, type) as any).n : (db.prepare(sql).get(jobId) as any).n;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as any).n;
}

async function main() {
  console.log("=== Phase 152 - Recovery Concurrency & Exactly-Once Integrity ===\n");

  // ==================================================================
  // Group A - Claim concurrency
  // ==================================================================

  console.log("152-A1 two claims on PENDING: exactly one wins");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    const ca = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    const cb = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(ca.claimed === true && cb.claimed === false, "A1 one winner");
    ok(cb.reason === "ACTIVE_CLAIM", "A1 loser reason");
    ok(getOp(h.db, "a1", "CANCELLATION").claim_owner === "A", "A1 owner is A");
  }

  console.log("\n152-A2 expired claim can be taken over");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    const cb = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(cb.claimed === true, "A2 B takes over");
    ok(getOp(h.db, "a2", "CANCELLATION").claim_owner === "B", "A2 new owner");
  }

  console.log("\n152-A3 live claim cannot be stolen");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    const cb = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(cb.claimed === false, "A3 rejected");
    ok(getOp(h.db, "a3", "CANCELLATION").claim_owner === "A", "A3 owner preserved");
  }

  console.log("\n152-A4 COMPLETED cannot be reclaimed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    const cb = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(cb.claimed === false && cb.reason === "ALREADY_COMPLETED", "A4 not reclaimable");
  }

  console.log("\n152-A5 claim increments attempt_count exactly once");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "C", durationMs: 60000 });
    ok(getOp(h.db, "a5", "CANCELLATION").attempt_count === 1, "A5 attempt_count=1");
  }

  console.log("\n152-A6 losing claim does not consume budget");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a6"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION",
    });
    const before = getOp(h.db, "a6", "CANCELLATION").attempt_count;
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(getOp(h.db, "a6", "CANCELLATION").attempt_count === before + 1, "A6 only one bump");
  }

  // ==================================================================
  // Group B - Stale-owner fencing
  // ==================================================================

  console.log("\n152-B1 stale owner cannot markCompleted");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    const r = h.store.recoveryOps.markCompleted(operation.operationId, "A");
    ok(r === false, "B1 A rejected");
    ok(getOp(h.db, "b1", "CANCELLATION").claim_owner === "B", "B1 B still owner");
  }

  console.log("\n152-B2 stale owner cannot markFailed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(h.store.recoveryOps.markFailed(operation.operationId, "A", "err") === false, "B2 A rejected");
  }

  console.log("\n152-B3 stale owner cannot markRecoveryRequired");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "err") === false, "B3 A rejected");
  }

  console.log("\n152-B4 stale owner cannot markInProgress");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(h.store.recoveryOps.markInProgress(operation.operationId, "A") === false, "B4 A rejected");
  }

  console.log("\n152-B5 new owner can complete after takeover");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(h.store.recoveryOps.markInProgress(operation.operationId, "B") === true, "B5 B in progress");
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "B") === true, "B5 B completed");
  }

  console.log("\n152-B6 stale owner cannot overwrite completed state");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b6"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "b6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    ok(h.store.recoveryOps.markFailed(operation.operationId, "A", "late") === false, "B6 late failed rejected");
    ok(getOp(h.db, "b6", "CANCELLATION").state === "COMPLETED", "B6 state preserved");
  }

  // ==================================================================
  // Group C - Crash/restart convergence
  // ==================================================================

  console.log("\n152-C1 crash after claim: reconcile resumes");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c1"));
    setJobRunning(h.db, "c1", "L1");
    seedLease(h.db, "c1", "w1", "L1", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.db.prepare("UPDATE execution_jobs SET cancellation_requested = 1 WHERE id = 'c1'").run();
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "c1").status === "CANCELLED", "C1 job CANCELLED");
    ok(getOp(h.db, "c1", "CANCELLATION").state === "COMPLETED", "C1 op COMPLETED");
  }

  console.log("\n152-C2 crash after IN_PROGRESS, job not yet mutated: reconcile re-runs");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c2", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "c2", "L2");
    seedLease(h.db, "c2", "w2", "L2", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c2", leaseId: "L2", workerId: "w2", operationType: "ORPHAN_RECOVERY",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 60000 });
    h.store.recoveryOps.markInProgress(operation.operationId, "dead");
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "c2").status === "QUEUED", "C2 job QUEUED");
    ok(countEvents(h.db, "c2", "execution.recovery.orphaned") === 1, "C2 one orphaned event");
  }

  console.log("\n152-C3 crash after job mutation, before markCompleted: finalize without replay");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c3"));
    setJobRunning(h.db, "c3", "L3");
    seedLease(h.db, "c3", "w3", "L3", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "c3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 60000 });
    h.store.recoveryOps.markInProgress(operation.operationId, "dead");
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoverJobAtomic({
      jobId: "c3", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L3",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L3", workerId: "w3", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    const beforeAttempt = getOp(h.db, "c3", "CANCELLATION").attempt_count;
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "c3", "CANCELLATION").state === "COMPLETED", "C3 op COMPLETED");
    ok(getOp(h.db, "c3", "CANCELLATION").attempt_count === beforeAttempt, "C3 attempt_count preserved");
    ok(countEvents(h.db, "c3", "execution.recovery.cancelled") === 1, "C3 one cancelled event");
    ok(countObligations(h.db, "c3") === 1, "C3 one obligation");
  }

  console.log("\n152-C4 DB close/reopen preserves durable state");
  {
    const dir = mkdtempSync(join(tmpdir(), "p152-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("c4"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "c4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.markInProgress(operation.operationId, "A");
      const opId = operation.operationId;
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getOp(h2.db, "c4", "CANCELLATION").state === "IN_PROGRESS", "C4 IN_PROGRESS durable");
      ok(getOp(h2.db, "c4", "CANCELLATION").claim_owner === "A", "C4 owner durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n152-C5 restart after COMPLETED: no duplicate work");
  {
    const dir = mkdtempSync(join(tmpdir(), "p152-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("c5"));
      setJobRunning(h1.db, "c5", "L5");
      seedLease(h1.db, "c5", "w5", "L5", "ACTIVE", Date.now() - 1000);
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "c5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.markInProgress(operation.operationId, "A");
      h1.store.recoverJobAtomic({
        jobId: "c5", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L5",
        event: { eventType: "execution.recovery.cancelled", payload: {} },
        obligation: { leaseId: "L5", workerId: "w5", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
      });
      h1.store.recoveryOps.markCompleted(operation.operationId, "A");
      const eventsBefore = countEvents(h1.db, "c5");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      h2.engineA.reconcileExecutionRecoveryOperations();
      h2.engineB.reconcileExecutionRecoveryOperations();
      ok(countEvents(h2.db, "c5") === eventsBefore, "C5 no new events after restart");
      ok(getOp(h2.db, "c5", "CANCELLATION").state === "COMPLETED", "C5 still COMPLETED");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ==================================================================
  // Group D - Duplicate recovery prevention
  // ==================================================================

  console.log("\n152-D1 duplicate timeout recovery: one reroute event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d1", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    setJobRunning(h.db, "d1", "L1");
    seedLease(h.db, "d1", "w1", "L1", "ACTIVE", Date.now() - 1000);
    insertAttempt(h.db, "a1", "d1", 1, "L1", "w1", Date.now() - 60000);
    h.store.recoverJobAtomic({
      jobId: "d1", expectedStatus: "RUNNING", newStatus: "FAILED", expectedLeaseId: "L1",
      event: { eventType: "execution.recovery.failed", payload: {} },
      obligation: { leaseId: "L1", workerId: "w1", reason: "TIMEOUT_ON_LEASE_LOSS" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d1", leaseId: "L1", workerId: "w1", operationType: "TIMEOUT",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(countEvents(h.db, "d1", "execution.recovery.rerouted") === 1, "D1 one rerouted event");
  }

  console.log("\n152-D2 duplicate orphan recovery: one requeue event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d2", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "d2", "L2");
    seedLease(h.db, "d2", "w2", "L2", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "d2", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L2",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: "L2", workerId: "w2", reason: "LEASE_EXPIRED" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d2", leaseId: "L2", workerId: "w2", operationType: "ORPHAN_RECOVERY",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(countEvents(h.db, "d2", "execution.recovery.requeued") === 1, "D2 one requeue event");
    ok(countEvents(h.db, "d2", "execution.recovery.orphaned") === 1, "D2 one orphaned event");
  }

  console.log("\n152-D3 duplicate cancellation recovery: one cancelled event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d3"));
    setJobRunning(h.db, "d3", "L3");
    seedLease(h.db, "d3", "w3", "L3", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "d3", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L3",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L3", workerId: "w3", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(countEvents(h.db, "d3", "execution.recovery.cancelled") === 1, "D3 one cancelled event");
  }

  console.log("\n152-D4 two engines reconcile: one authoritative final state");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d4"));
    setJobRunning(h.db, "d4", "L4");
    seedLease(h.db, "d4", "w4", "L4", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "d4", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L4",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L4", workerId: "w4", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "d4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "d4", "CANCELLATION").state === "COMPLETED", "D4 COMPLETED");
    ok(countEvents(h.db, "d4", "execution.recovery.cancelled") === 1, "D4 one event");
  }

  console.log("\n152-D5 one op row per logical recovery identity");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d5"));
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.createOrGetOperation({
        jobId: "d5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION",
      });
    }
    ok(countOpRows(h.db, "d5", "CANCELLATION") === 1, "D5 one op row");
  }

  // ==================================================================
  // Group E - Retry-budget integrity
  // ==================================================================

  console.log("\n152-E1 attempt_count consumed once per successful claim");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markInProgress(operation.operationId, "A");
    h.store.recoveryOps.markFailed(operation.operationId, "A", "err");
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(getOp(h.db, "e1", "CANCELLATION").attempt_count === 2, "E1 exactly two claims counted");
  }

  console.log("\n152-E2 finalizeCompletedOperation does not bump attempt_count");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e2"));
    setJobRunning(h.db, "e2", "L2");
    seedLease(h.db, "e2", "w2", "L2", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    const before = getOp(h.db, "e2", "CANCELLATION").attempt_count;
    h.store.recoveryOps.finalizeCompletedOperation(operation.operationId);
    ok(getOp(h.db, "e2", "CANCELLATION").attempt_count === before, "E2 no bump");
  }

  console.log("\n152-E3 repeated reconcile of completed op does not bump budget");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e3"));
    setJobRunning(h.db, "e3", "L3");
    seedLease(h.db, "e3", "w3", "L3", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "e3", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L3",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L3", workerId: "w3", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    const after = getOp(h.db, "e3", "CANCELLATION").attempt_count;
    for (let i = 0; i < 3; i++) h.engineA.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "e3", "CANCELLATION").attempt_count === after, "E3 stable budget");
  }

  console.log("\n152-E4 budget threshold escalation to RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e4", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "e4", "L4");
    seedLease(h.db, "e4", "w4", "L4", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "e4", leaseId: "L4", workerId: "w4", operationType: "ORPHAN_RECOVERY",
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='FAILED', attempt_count=5, claim_owner=NULL, claim_expires_at=NULL WHERE operation_id = ?")
      .run(operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "e4", "ORPHAN_RECOVERY").state === "RECOVERY_REQUIRED", "E4 escalated");
  }

  console.log("\n152-E5 Phase 146 budget on live recoverStaleJobs preserved");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e5", { retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    const c = h.store.atomicClaimJob({ jobId: "e5", workerId: "w5", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='e5'").run();
    insertAttempt(h.db, "ea5", "e5", 1, c.lease!.leaseId, "w5", Date.now() - 60000);
    insertAttempt(h.db, "eb5", "e5", 2, c.lease!.leaseId, "w5", Date.now() - 60000);
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, c.lease!.leaseId);
    (h.engineA as any).leaseManager = { recoverExpiredLeases: () => [{ jobId: "e5", leaseId: c.lease!.leaseId, workerId: "w5", expiresAt: Date.now() - 1000 }] };
    h.engineA.recoverStaleJobs();
    ok(getJob(h.db, "e5").status === "DEAD_LETTER", "E5 budget enforced");
  }

  // ==================================================================
  // Group F - Concurrent reconciliation
  // ==================================================================

  console.log("\n152-F1 concurrent reconcile: one winner on PENDING op");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f1"));
    setJobRunning(h.db, "f1", "L1");
    seedLease(h.db, "f1", "w1", "L1", "ACTIVE", Date.now() - 1000);
    h.db.prepare("UPDATE execution_jobs SET cancellation_requested=1 WHERE id='f1'").run();
    // Seed the op PENDING: crash after createOrGet but before claim.
    h.store.recoveryOps.createOrGetOperation({
      jobId: "f1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "f1").status === "CANCELLED", "F1 CANCELLED");
    ok(countEvents(h.db, "f1", "execution.recovery.cancelled") === 1, "F1 one event");
    ok(countObligations(h.db, "f1") === 1, "F1 one obligation");
  }

  console.log("\n152-F2 concurrent reconcile on expired claim: one takes over");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f2"));
    setJobRunning(h.db, "f2", "L2");
    seedLease(h.db, "f2", "w2", "L2", "ACTIVE", Date.now() - 1000);
    h.db.prepare("UPDATE execution_jobs SET cancellation_requested=1 WHERE id='f2'").run();
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "f2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "f2").status === "CANCELLED", "F2 CANCELLED");
    ok(countEvents(h.db, "f2", "execution.recovery.cancelled") === 1, "F2 one event");
  }

  console.log("\n152-F3 postcondition satisfied: one finalize, one no-op");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f3"));
    setJobRunning(h.db, "f3", "L3");
    seedLease(h.db, "f3", "w3", "L3", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "f3", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L3",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L3", workerId: "w3", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "f3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "f3", "CANCELLATION").state === "COMPLETED", "F3 COMPLETED");
    ok(countEvents(h.db, "f3", "execution.recovery.cancelled") === 1, "F3 one event");
  }

  console.log("\n152-F4 inconsistent state: one RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f4"));
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='f4'").run();
    seedLease(h.db, "f4", "w4", "L4", "ACTIVE", Date.now() - 1000);
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "f4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "f4", "CANCELLATION").state === "RECOVERY_REQUIRED", "F4 RECOVERY_REQUIRED");
    ok(getJob(h.db, "f4").status === "SUCCEEDED", "F4 terminal job untouched");
  }

  console.log("\n152-F5 concurrent reconcile: terminal job never resurrected");
  {
    const h = makeHarness();
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER"]) {
      h.store.createJob(queuedJob("f5-" + terminal));
      h.db.prepare("UPDATE execution_jobs SET status=? WHERE id=?").run(terminal, "f5-" + terminal);
    }
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER"]) {
      ok(getJob(h.db, "f5-" + terminal).status === terminal, "F5 " + terminal + " stable");
    }
  }

  // ==================================================================
  // Group G - Additional edge cases
  // ==================================================================

  console.log("\n152-G1 op creation race converges to one row");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g1"));
    const a = h.store.recoveryOps.createOrGetOperation({ jobId: "g1", leaseId: "L1", workerId: "w1", operationType: "REQUEUE" });
    const b = h.store.recoveryOps.createOrGetOperation({ jobId: "g1", leaseId: "L1", workerId: "w1", operationType: "REQUEUE" });
    ok(a.operation.operationId === b.operation.operationId, "G1 same op id");
    ok(countOpRows(h.db, "g1", "REQUEUE") === 1, "G1 one row");
  }

  console.log("\n152-G2 conflicting terminal results rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "g2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    ok(h.store.recoveryOps.markFailed(operation.operationId, "A", "late") === false, "G2 late failed rejected");
    ok(h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "late") === false, "G2 late recovery rejected");
  }

  console.log("\n152-G3 RECOVERY_REQUIRED not auto-resurrected by reconcile");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "g3", leaseId: "L3", workerId: "w3", operationType: "ORPHAN_RECOVERY",
    });
    h.db.prepare("UPDATE execution_recovery_operations SET state='RECOVERY_REQUIRED', claim_owner=NULL, claim_expires_at=NULL WHERE operation_id=?").run(operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "g3", "ORPHAN_RECOVERY").state === "RECOVERY_REQUIRED", "G3 state preserved");
  }

  console.log("\n152-G4 claim takeover after expiry, stale resume rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "g4", leaseId: "L4", workerId: "w4", operationType: "CANCELLATION",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "A") === false, "G4 stale A rejected");
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "B") === true, "G4 B succeeds");
  }

  console.log("\n152-G5 complete end-to-end concurrent recovery");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("g5", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "g5", "L5");
    seedLease(h.db, "g5", "w5", "L5", "ACTIVE", Date.now() - 1000);
    h.store.recoverJobAtomic({
      jobId: "g5", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L5",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: "L5", workerId: "w5", reason: "LEASE_EXPIRED" },
    });
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "g5", leaseId: "L5", workerId: "w5", operationType: "ORPHAN_RECOVERY",
    });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
      .run(Date.now() - 1000, operation.operationId);
    h.engineA.reconcileExecutionRecoveryOperations();
    h.engineB.reconcileExecutionRecoveryOperations();
    h.engineA.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "g5").status === "QUEUED", "G5 QUEUED");
    ok(getOp(h.db, "g5", "ORPHAN_RECOVERY").state === "COMPLETED", "G5 COMPLETED");
    ok(countEvents(h.db, "g5", "execution.recovery.orphaned") === 1, "G5 one orphaned");
    ok(countEvents(h.db, "g5", "execution.recovery.requeued") === 1, "G5 one requeued");
    ok(countObligations(h.db, "g5") === 1, "G5 one obligation");
  }

  console.log("\n--- Phase 152: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE152 DRIVER CRASH:", err); process.exit(1); });
