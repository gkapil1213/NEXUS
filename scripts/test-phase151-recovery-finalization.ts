// scripts/test-phase151-recovery-finalization.ts
// Phase 151 - recovery operation finalization after crash.
//
// Simulates the crash-after-commit boundary by seeding the durable state a
// crash would leave: the recovery op is IN_PROGRESS with an expired claim,
// and the underlying job mutation already committed. Then runs the real
// reconciler and verifies convergence.
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

interface H { db: Database.Database; store: ExecutionStore; engine: ExecutionEngine; }

function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const engine = new ExecutionEngine(store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
  return { db: rawDb, store, engine };
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

function seedLease(db: Database.Database, jobId: string, workerId: string, leaseId: string, status: string, expiresAt: number): void {
  db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now() - 120000, expiresAt, status);
}
function setJobRunning(db: Database.Database, jobId: string, leaseId: string | null): void {
  db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
}
function insertAttempt(db: Database.Database, id: string, jobId: string, num: number, leaseId: string, workerId: string, startedAt: number): void {
  db.prepare(
    "INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, started_at, created_at) " +
    "VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, jobId, num, "RUNNING", workerId, leaseId, startedAt, Date.now());
}
function getJob(db: Database.Database, id: string) { return db.prepare("SELECT status, current_lease_id FROM execution_jobs WHERE id = ?").get(id) as any; }
function getOp(db: Database.Database, jobId: string, type: string) {
  return db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ? ORDER BY created_at DESC LIMIT 1").get(jobId, type) as any;
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

// Seed op as if runRecoveryOperation had been interrupted after body() committed.
function seedCrashedOp(h: H, input: {
  jobId: string; leaseId: string; workerId: string; operationType: string;
}): string {
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId: input.jobId, leaseId: input.leaseId, workerId: input.workerId,
    operationType: input.operationType as any,
  });
  const owner = "dead-owner";
  h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner, durationMs: 60000 });
  h.store.recoveryOps.markInProgress(operation.operationId, owner);
  // Expire the claim: this is the "process died" signal.
  h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?")
    .run(Date.now() - 1000, operation.operationId);
  return operation.operationId;
}

async function main() {
  console.log("=== Phase 151 - Recovery Operation Finalization ===\n");

  console.log("151-1 CANCELLATION crash-after-commit finalizes without replaying");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1"));
    setJobRunning(h.db, "j1", "L1");
    seedLease(h.db, "j1", "w1", "L1", "ACTIVE", Date.now() - 1000);
    const opId = seedCrashedOp(h, { jobId: "j1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION" });

    // Body committed before the crash:
    h.store.recoverJobAtomic({
      jobId: "j1", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L1",
      event: { eventType: "execution.recovery.cancelled", payload: { jobId: "j1" } },
      obligation: { leaseId: "L1", workerId: "w1", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });

    const beforeEvents = countEvents(h.db, "j1", "execution.recovery.cancelled");
    const beforeObligations = countObligations(h.db, "j1");
    const beforeAttempts = getOp(h.db, "j1", "CANCELLATION").attempt_count;

    h.engine.reconcileExecutionRecoveryOperations();

    const op = getOp(h.db, "j1", "CANCELLATION");
    ok(op.state === "COMPLETED", "151-1 op COMPLETED");
    ok(getJob(h.db, "j1").status === "CANCELLED", "151-1 job CANCELLED");
    ok(countEvents(h.db, "j1", "execution.recovery.cancelled") === beforeEvents, "151-1 no extra cancelled event");
    ok(countObligations(h.db, "j1") === beforeObligations, "151-1 no extra obligation");
    ok(op.attempt_count === beforeAttempts, "151-1 attempt_count not bumped");
  }

  console.log("\n151-2 TIMEOUT step-1 committed, reconcile completes step-2");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    setJobRunning(h.db, "j2", "L2");
    seedLease(h.db, "j2", "w2", "L2", "ACTIVE", Date.now() - 1000);
    insertAttempt(h.db, "a2", "j2", 1, "L2", "w2", Date.now() - 60000);
    const opId = seedCrashedOp(h, { jobId: "j2", leaseId: "L2", workerId: "w2", operationType: "TIMEOUT" });

    // Step-1 committed: job -> FAILED
    h.store.recoverJobAtomic({
      jobId: "j2", expectedStatus: "RUNNING", newStatus: "FAILED", expectedLeaseId: "L2",
      event: { eventType: "execution.recovery.failed", payload: { jobId: "j2" } },
      obligation: { leaseId: "L2", workerId: "w2", reason: "TIMEOUT_ON_LEASE_LOSS" },
    });

    h.engine.reconcileExecutionRecoveryOperations();

    const op = getOp(h.db, "j2", "TIMEOUT");
    ok(op.state === "COMPLETED", "151-2 op COMPLETED");
    ok(getJob(h.db, "j2").status === "RETRY_SCHEDULED" || getJob(h.db, "j2").status === "DEAD_LETTER", "151-2 step-2 completed");
    ok(countEvents(h.db, "j2", "execution.recovery.failed") === 1, "151-2 one failed event");
    ok(countEvents(h.db, "j2", "execution.recovery.rerouted") === 1, "151-2 one rerouted event");
  }

  console.log("\n151-3 TIMEOUT step-2 committed to RETRY_SCHEDULED, finalize only");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    setJobRunning(h.db, "j3", "L3");
    seedLease(h.db, "j3", "w3", "L3", "ACTIVE", Date.now() - 1000);
    insertAttempt(h.db, "a3", "j3", 1, "L3", "w3", Date.now() - 60000);
    const opId = seedCrashedOp(h, { jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "TIMEOUT" });

    h.store.recoverJobAtomic({
      jobId: "j3", expectedStatus: "RUNNING", newStatus: "FAILED", expectedLeaseId: "L3",
      event: { eventType: "execution.recovery.failed", payload: {} },
      obligation: { leaseId: "L3", workerId: "w3", reason: "TIMEOUT_ON_LEASE_LOSS" },
    });
    h.store.recoverJobAtomic({
      jobId: "j3", expectedStatus: "FAILED", newStatus: "RETRY_SCHEDULED", expectedLeaseId: null,
      patch: { nextAttemptAt: Date.now() } as any,
      event: { eventType: "execution.recovery.rerouted", payload: { to: "RETRY_SCHEDULED" } },
    });

    const beforeAttemptCount = getOp(h.db, "j3", "TIMEOUT").attempt_count;
    h.engine.reconcileExecutionRecoveryOperations();
    const op = getOp(h.db, "j3", "TIMEOUT");
    ok(op.state === "COMPLETED", "151-3 op COMPLETED");
    ok(getJob(h.db, "j3").status === "RETRY_SCHEDULED" || getJob(h.db, "j3").status === "QUEUED", "151-3 job postcondition");
    ok(countEvents(h.db, "j3", "execution.recovery.rerouted") === 1, "151-3 one rerouted event");
    ok(op.attempt_count === beforeAttemptCount, "151-3 attempt_count preserved");
  }

  console.log("\n151-4 TIMEOUT step-2 committed to DEAD_LETTER, finalize only");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4", { timeoutMs: 1000 } as any));
    setJobRunning(h.db, "j4", "L4");
    seedLease(h.db, "j4", "w4", "L4", "ACTIVE", Date.now() - 1000);
    insertAttempt(h.db, "a4", "j4", 1, "L4", "w4", Date.now() - 60000);
    seedCrashedOp(h, { jobId: "j4", leaseId: "L4", workerId: "w4", operationType: "TIMEOUT" });

    h.store.recoverJobAtomic({
      jobId: "j4", expectedStatus: "RUNNING", newStatus: "FAILED", expectedLeaseId: "L4",
      event: { eventType: "execution.recovery.failed", payload: {} },
      obligation: { leaseId: "L4", workerId: "w4", reason: "TIMEOUT_ON_LEASE_LOSS" },
    });
    h.store.recoverJobAtomic({
      jobId: "j4", expectedStatus: "FAILED", newStatus: "DEAD_LETTER", expectedLeaseId: null,
      event: { eventType: "execution.recovery.rerouted", payload: { to: "DEAD_LETTER" } },
    });

    h.engine.reconcileExecutionRecoveryOperations();
    const op = getOp(h.db, "j4", "TIMEOUT");
    ok(op.state === "COMPLETED", "151-4 op COMPLETED");
    ok(getJob(h.db, "j4").status === "DEAD_LETTER", "151-4 DEAD_LETTER");
    ok(countEvents(h.db, "j4", "execution.recovery.rerouted") === 1, "151-4 one rerouted event");
  }

  console.log("\n151-5 ORPHAN_RECOVERY step-1 committed, reconcile completes step-2");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j5", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "j5", "L5");
    seedLease(h.db, "j5", "w5", "L5", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j5", leaseId: "L5", workerId: "w5", operationType: "ORPHAN_RECOVERY" });

    h.store.recoverJobAtomic({
      jobId: "j5", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L5",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: "L5", workerId: "w5", reason: "LEASE_EXPIRED" },
    });

    h.engine.reconcileExecutionRecoveryOperations();
    const op = getOp(h.db, "j5", "ORPHAN_RECOVERY");
    ok(op.state === "COMPLETED", "151-5 op COMPLETED");
    ok(getJob(h.db, "j5").status === "QUEUED", "151-5 QUEUED");
    ok(countEvents(h.db, "j5", "execution.recovery.orphaned") === 1, "151-5 one orphaned event");
    ok(countEvents(h.db, "j5", "execution.recovery.requeued") === 1, "151-5 one requeued event");
    ok(countObligations(h.db, "j5") === 1, "151-5 one obligation");
  }

  console.log("\n151-6 ORPHAN_RECOVERY step-2 committed (QUEUED), finalize only");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j6", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "j6", "L6");
    seedLease(h.db, "j6", "w6", "L6", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j6", leaseId: "L6", workerId: "w6", operationType: "ORPHAN_RECOVERY" });

    h.store.recoverJobAtomic({
      jobId: "j6", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L6",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: "L6", workerId: "w6", reason: "LEASE_EXPIRED" },
    });
    h.store.recoverJobAtomic({
      jobId: "j6", expectedStatus: "ORPHANED", newStatus: "QUEUED", expectedLeaseId: null,
      patch: { nextAttemptAt: Date.now() } as any,
      event: { eventType: "execution.recovery.requeued", payload: {} },
    });

    h.engine.reconcileExecutionRecoveryOperations();
    const op = getOp(h.db, "j6", "ORPHAN_RECOVERY");
    ok(op.state === "COMPLETED", "151-6 op COMPLETED");
    ok(getJob(h.db, "j6").status === "QUEUED", "151-6 QUEUED");
    ok(countEvents(h.db, "j6", "execution.recovery.orphaned") === 1, "151-6 one orphaned event");
    ok(countEvents(h.db, "j6", "execution.recovery.requeued") === 1, "151-6 one requeued event");
  }

  console.log("\n151-7 double reconciliation is fully idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j7"));
    setJobRunning(h.db, "j7", "L7");
    seedLease(h.db, "j7", "w7", "L7", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j7", leaseId: "L7", workerId: "w7", operationType: "CANCELLATION" });
    h.store.recoverJobAtomic({
      jobId: "j7", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L7",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L7", workerId: "w7", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });

    const beforeE = countEvents(h.db, "j7");
    const beforeO = countObligations(h.db, "j7");
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getOp(h.db, "j7", "CANCELLATION").state === "COMPLETED", "151-7 op COMPLETED");
    ok(countEvents(h.db, "j7") === beforeE, "151-7 no extra events");
    ok(countObligations(h.db, "j7") === beforeO, "151-7 no extra obligations");
  }

  console.log("\n151-8 two engines reconcile after crash, one authoritative result");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j8"));
    setJobRunning(h.db, "j8", "L8");
    seedLease(h.db, "j8", "w8", "L8", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j8", leaseId: "L8", workerId: "w8", operationType: "CANCELLATION" });
    h.store.recoverJobAtomic({
      jobId: "j8", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L8",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L8", workerId: "w8", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });

    const engine2 = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engine.reconcileExecutionRecoveryOperations();
    engine2.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();

    ok(getOp(h.db, "j8", "CANCELLATION").state === "COMPLETED", "151-8 op COMPLETED");
    ok(countEvents(h.db, "j8", "execution.recovery.cancelled") === 1, "151-8 one cancelled event");
    ok(countObligations(h.db, "j8") === 1, "151-8 one obligation");
  }

  console.log("\n151-9 stale owner cannot re-finalize an op already COMPLETED by reconciler");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j9"));
    setJobRunning(h.db, "j9", "L9");
    seedLease(h.db, "j9", "w9", "L9", "ACTIVE", Date.now() - 1000);
    const opId = seedCrashedOp(h, { jobId: "j9", leaseId: "L9", workerId: "w9", operationType: "CANCELLATION" });
    h.store.recoverJobAtomic({
      jobId: "j9", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L9",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L9", workerId: "w9", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });

    h.engine.reconcileExecutionRecoveryOperations();
    const completed = getOp(h.db, "j9", "CANCELLATION");
    ok(completed.state === "COMPLETED", "151-9 reconciler finalized");

    // Stale owner tries again with the original owner id.
    const res = h.store.recoveryOps.markCompleted(opId, "dead-owner");
    ok(res === false, "151-9 stale markCompleted rejected");
    ok(getOp(h.db, "j9", "CANCELLATION").state === "COMPLETED", "151-9 still COMPLETED");
  }

  console.log("\n151-10 already COMPLETED op is a reconcile no-op");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j10"));
    setJobRunning(h.db, "j10", "L10");
    seedLease(h.db, "j10", "w10", "L10", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j10", leaseId: "L10", workerId: "w10", operationType: "CANCELLATION" });
    h.store.recoverJobAtomic({
      jobId: "j10", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L10",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L10", workerId: "w10", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    h.engine.reconcileExecutionRecoveryOperations();
    const before = JSON.stringify(getOp(h.db, "j10", "CANCELLATION"));
    h.engine.reconcileExecutionRecoveryOperations();
    const after = JSON.stringify(getOp(h.db, "j10", "CANCELLATION"));
    ok(before === after, "151-10 op unchanged on re-reconcile");
  }

  console.log("\n151-11 unexpected job state preserved as RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j11"));
    // Job is SUCCEEDED but a CANCELLATION recovery op is somehow IN_PROGRESS.
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='j11'").run();
    seedLease(h.db, "j11", "w11", "L11", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j11", leaseId: "L11", workerId: "w11", operationType: "CANCELLATION" });

    h.engine.reconcileExecutionRecoveryOperations();
    const op = getOp(h.db, "j11", "CANCELLATION");
    ok(op.state === "RECOVERY_REQUIRED", "151-11 op RECOVERY_REQUIRED");
    ok(getJob(h.db, "j11").status === "SUCCEEDED", "151-11 terminal job untouched");
    ok(!!op.last_error, "151-11 error evidence persisted");
  }

  console.log("\n151-12 crash-after-commit does not consume attempt budget");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j12"));
    setJobRunning(h.db, "j12", "L12");
    seedLease(h.db, "j12", "w12", "L12", "ACTIVE", Date.now() - 1000);
    const opId = seedCrashedOp(h, { jobId: "j12", leaseId: "L12", workerId: "w12", operationType: "CANCELLATION" });
    const before = getOp(h.db, "j12", "CANCELLATION").attempt_count;
    h.store.recoverJobAtomic({
      jobId: "j12", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L12",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L12", workerId: "w12", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    const after = getOp(h.db, "j12", "CANCELLATION").attempt_count;
    ok(after === before, "151-12 attempt_count unchanged by finalization");
  }

  console.log("\n151-13 repeated reconciliation produces no duplicate events");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j13", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setJobRunning(h.db, "j13", "L13");
    seedLease(h.db, "j13", "w13", "L13", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j13", leaseId: "L13", workerId: "w13", operationType: "ORPHAN_RECOVERY" });
    h.store.recoverJobAtomic({
      jobId: "j13", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L13",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: "L13", workerId: "w13", reason: "LEASE_EXPIRED" },
    });
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(countEvents(h.db, "j13", "execution.recovery.orphaned") === 1, "151-13 one orphaned event");
    ok(countEvents(h.db, "j13", "execution.recovery.requeued") === 1, "151-13 one requeued event");
    ok(countObligations(h.db, "j13") === 1, "151-13 one obligation");
  }

  console.log("\n151-14 no duplicate obligations after repeated reconcile");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j14"));
    setJobRunning(h.db, "j14", "L14");
    seedLease(h.db, "j14", "w14", "L14", "ACTIVE", Date.now() - 1000);
    seedCrashedOp(h, { jobId: "j14", leaseId: "L14", workerId: "w14", operationType: "CANCELLATION" });
    h.store.recoverJobAtomic({
      jobId: "j14", expectedStatus: "RUNNING", newStatus: "CANCELLED", expectedLeaseId: "L14",
      event: { eventType: "execution.recovery.cancelled", payload: {} },
      obligation: { leaseId: "L14", workerId: "w14", reason: "CANCELLATION_REQUESTED_ON_LEASE_LOSS" },
    });
    for (let i = 0; i < 5; i++) h.engine.reconcileExecutionRecoveryOperations();
    ok(countObligations(h.db, "j14") === 1, "151-14 exactly one obligation");
  }

  console.log("\n151-15 process reload: fresh engine converges");
  {
    const dir = mkdtempSync(join(tmpdir(), "p151-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j15", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
      setJobRunning(h1.db, "j15", "L15");
      seedLease(h1.db, "j15", "w15", "L15", "ACTIVE", Date.now() - 1000);
      seedCrashedOp(h1, { jobId: "j15", leaseId: "L15", workerId: "w15", operationType: "ORPHAN_RECOVERY" });
      h1.store.recoverJobAtomic({
        jobId: "j15", expectedStatus: "RUNNING", newStatus: "ORPHANED", expectedLeaseId: "L15",
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: "L15", workerId: "w15", reason: "LEASE_EXPIRED" },
      });
      h1.db.close();

      const h2 = makeHarness(dbFile);
      h2.engine.reconcileExecutionRecoveryOperations();
      ok(getJob(h2.db, "j15").status === "QUEUED", "151-15 reload: job QUEUED");
      ok(getOp(h2.db, "j15", "ORPHAN_RECOVERY").state === "COMPLETED", "151-15 reload: op COMPLETED");
      ok(countObligations(h2.db, "j15") === 1, "151-15 reload: one obligation");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n--- Phase 151: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE151 DRIVER CRASH:", err); process.exit(1); });
