// scripts/test-phase144-durable-recovery-operations.ts
// Phase 144 - durable execution recovery operations.
//
// Exercises the real SQLite migration path and the real ExecutionEngine /
// ExecutionStore. Every assertion reads durable rows. No mocks of recovery.

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

interface H { db: Database.Database; store: ExecutionStore; }
function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  return { db: rawDb, store };
}

interface EngineH extends H {
  engine: ExecutionEngine;
  pushExpired(jobId: string, leaseId: string, workerId: string): void;
}
function makeEngineHarness(dbFile?: string, engineTag = "e1"): EngineH {
  const h = makeHarness(dbFile);
  const queue: Array<{ jobId: string; leaseId: string; workerId: string; expiresAt: number }> = [];
  const leaseManager: any = {
    recoverExpiredLeases: (_now: number) => {
      const out = queue.slice();
      queue.length = 0;
      return out;
    },
  };
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const retryEngine: any = {};
  const engine = new ExecutionEngine(h.store, workerRegistry, leaseManager, retryEngine, {});
  return {
    ...h,
    engine,
    pushExpired: (jobId, leaseId, workerId) => {
      queue.push({ jobId, leaseId, workerId, expiresAt: Date.now() - 1000 });
    },
  };
}

function queuedJob(id: string, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = Date.now();
  return {
    id,
    idempotencyKey: "k-" + id,
    jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
    ...extra,
  } as ExecutionJob;
}

function getJob(db: Database.Database, id: string) {
  return db.prepare("SELECT status, current_lease_id, cancellation_requested, next_attempt_at FROM execution_jobs WHERE id = ?").get(id) as any;
}
function countEvents(db: Database.Database, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type
    ? (db.prepare(sql).get(jobId, type) as any).n
    : (db.prepare(sql).get(jobId) as any).n;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as any).n;
}
function countRecoveryOps(db: Database.Database, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?";
  return type
    ? (db.prepare(sql).get(jobId, type) as any).n
    : (db.prepare(sql).get(jobId) as any).n;
}
function getRecoveryOp(db: Database.Database, jobId: string, type: string) {
  return db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ? ORDER BY created_at DESC LIMIT 1").get(jobId, type) as any;
}
function expireLease(db: Database.Database, jobId: string): string {
  const lease = db.prepare("SELECT lease_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'").get(jobId) as any;
  if (!lease) throw new Error("no active lease for " + jobId);
  db.prepare("UPDATE execution_leases SET status = 'EXPIRED', expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, lease.lease_id);
  return lease.lease_id;
}

async function main() {
  console.log("=== Phase 144 - Durable Execution Recovery Operations ===\n");

  console.log("144-1 migration 154 applies");
  {
    const h = makeHarness();
    const row = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_recovery_operations'").get() as any;
    ok(!!row, "144-1 table exists");
    const cols = h.db.prepare("PRAGMA table_info(execution_recovery_operations)").all() as any[];
    const names = cols.map((c) => c.name);
    for (const required of ["operation_id","job_id","lease_id","worker_id","operation_type","state","idempotency_key","attempt_count","last_error","created_at","updated_at","completed_at"]) {
      ok(names.includes(required), "144-1 column " + required);
    }
  }

  console.log("\n144-2 recovery operation creation persists");
  {
    const h = makeHarness();
    const { operation, created } = h.store.recoveryOps.createOrGetOperation({
      jobId: "j2", leaseId: "L2", workerId: "w2", operationType: "CANCELLATION",
    });
    ok(created, "144-2 created flag true");
    const row = h.db.prepare("SELECT state, operation_type FROM execution_recovery_operations WHERE operation_id = ?").get(operation.operationId) as any;
    ok(!!row && row.state === "PENDING", "144-2 row PENDING");
    ok(row.operation_type === "CANCELLATION", "144-2 operation_type durable");
  }

  console.log("\n144-3 create-or-get is idempotent");
  {
    const h = makeHarness();
    const a = h.store.recoveryOps.createOrGetOperation({ jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "TIMEOUT" });
    const b = h.store.recoveryOps.createOrGetOperation({ jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "TIMEOUT" });
    const c = h.store.recoveryOps.createOrGetOperation({ jobId: "j3", leaseId: "L3", workerId: "w3", operationType: "TIMEOUT" });
    ok(a.created === true, "144-3 first create");
    ok(b.created === false && c.created === false, "144-3 subsequent return existing");
    ok(a.operation.operationId === b.operation.operationId && b.operation.operationId === c.operation.operationId, "144-3 same operation id");
    ok(countRecoveryOps(h.db, "j3", "TIMEOUT") === 1, "144-3 one row");
  }

  console.log("\n144-4 concurrent duplicate creation produces one operation");
  {
    const h = makeHarness();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(h.store.recoveryOps.createOrGetOperation({ jobId: "j4", leaseId: "L4", workerId: "w" + i, operationType: "ORPHAN_RECOVERY" }));
    }
    const ids = new Set(results.map((r) => r.operation.operationId));
    ok(ids.size === 1, "144-4 one authoritative operation");
    ok(countRecoveryOps(h.db, "j4", "ORPHAN_RECOVERY") === 1, "144-4 one row");
  }

  console.log("\n144-5 claim is atomic");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j5", leaseId: "L5", workerId: "w5", operationType: "CANCELLATION" });
    const r = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "owner-1", durationMs: 60000 });
    ok(r.claimed, "144-5 claim succeeds");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.state === "CLAIMED", "144-5 CLAIMED");
    ok(op.attemptCount === 1, "144-5 attempt_count 1");
    ok(op.claimOwner === "owner-1", "144-5 owner recorded");
  }

  console.log("\n144-6 competing claims: only one wins");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j6", leaseId: "L6", workerId: "w6", operationType: "CANCELLATION" });
    const a = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    const b = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(a.claimed && !b.claimed, "144-6 exactly one wins");
    ok(b.reason === "ACTIVE_CLAIM", "144-6 loser reason ACTIVE_CLAIM");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.claimOwner === "A", "144-6 owner remains A");
    ok(op.attemptCount === 1, "144-6 attempt_count not bumped by loser");
  }

  console.log("\n144-7 expired claim is reclaimable");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j7", leaseId: "L7", workerId: "w7", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "dead", durationMs: 1 });
    // Force expiry
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?").run(Date.now() - 1000, operation.operationId);
    const reclaim = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "alive", durationMs: 60000 });
    ok(reclaim.claimed, "144-7 expired claim reclaimable");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.claimOwner === "alive", "144-7 new owner");
    ok(op.attemptCount === 2, "144-7 attempt_count 2");
  }

  console.log("\n144-8 stale owner cannot complete a reclaimed operation");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j8", leaseId: "L8", workerId: "w8", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 1 });
    h.db.prepare("UPDATE execution_recovery_operations SET claim_expires_at = ? WHERE operation_id = ?").run(Date.now() - 1000, operation.operationId);
    const reclaim = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(reclaim.claimed, "144-8 B reclaims");
    const stale = h.store.recoveryOps.markCompleted(operation.operationId, "A");
    ok(!stale, "144-8 A cannot mark completed");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.state === "CLAIMED", "144-8 state unchanged (still CLAIMED by B)");
    ok(op.claimOwner === "B", "144-8 owner still B");
  }

  console.log("\n144-9 mark transitions require live claim owner");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j9", leaseId: "L9", workerId: "w9", operationType: "CANCELLATION" });
    ok(!h.store.recoveryOps.markInProgress(operation.operationId, "x"), "144-9 no mark without claim");
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    ok(!h.store.recoveryOps.markInProgress(operation.operationId, "WRONG"), "144-9 wrong owner rejected");
    ok(h.store.recoveryOps.markInProgress(operation.operationId, "A"), "144-9 correct owner accepted");
    ok(h.store.recoveryOps.markCompleted(operation.operationId, "A"), "144-9 complete as A");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.state === "COMPLETED", "144-9 COMPLETED");
    ok(op.claimOwner === null && op.claimExpiresAt === null, "144-9 claim cleared");
    ok(op.completedAt !== null, "144-9 completed_at set");
    // Second complete must fail
    ok(!h.store.recoveryOps.markCompleted(operation.operationId, "A"), "144-9 cannot re-complete");
  }

  console.log("\n144-10 COMPLETED is terminal");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j10", leaseId: "L10", workerId: "w10", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markCompleted(operation.operationId, "A");
    const reclaim = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "B", durationMs: 60000 });
    ok(!reclaim.claimed, "144-10 COMPLETED not reclaimable");
    ok(reclaim.reason === "ALREADY_COMPLETED", "144-10 reason ALREADY_COMPLETED");
  }

  console.log("\n144-11 markFailed persists error");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j11", leaseId: "L11", workerId: "w11", operationType: "CANCELLATION" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    const mark = h.store.recoveryOps.markFailed(operation.operationId, "A", "INJECTED_FAILURE");
    ok(mark, "144-11 markFailed returns true");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.state === "FAILED", "144-11 state FAILED");
    ok(op.lastError === "INJECTED_FAILURE", "144-11 last_error durable");
    ok(op.claimOwner === null, "144-11 claim cleared");
  }

  console.log("\n144-12 markRecoveryRequired is durable");
  {
    const h = makeHarness();
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "j12", leaseId: "L12", workerId: "w12", operationType: "ORPHAN_RECOVERY" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    h.store.recoveryOps.markRecoveryRequired(operation.operationId, "A", "NON_RETRYABLE_ORPHAN");
    const op = h.store.recoveryOps.getOperation(operation.operationId)!;
    ok(op.state === "RECOVERY_REQUIRED", "144-12 state RECOVERY_REQUIRED");
    ok(op.lastError === "NON_RETRYABLE_ORPHAN", "144-12 error durable");
  }

  console.log("\n144-13 cancellation recovery completes as CANCELLED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j13"));
    const c = h.store.atomicClaimJob({ jobId: "j13", workerId: "w13", durationMs: 60000 });
    h.store.requestCancellation("j13");
    expireLease(h.db, "j13");
    h.pushExpired("j13", c.lease!.leaseId, "w13");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j13").status === "CANCELLED", "144-13 status CANCELLED");
    const op = getRecoveryOp(h.db, "j13", "CANCELLATION");
    ok(!!op && op.state === "COMPLETED", "144-13 CANCELLATION op COMPLETED");
    ok(countObligations(h.db, "j13") === 1, "144-13 one obligation (no duplicate)");
    ok(countEvents(h.db, "j13", "execution.recovery.cancelled") === 1, "144-13 one cancelled event");
  }

  console.log("\n144-14 cancellation precedence over timeout/orphan");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j14", { timeoutMs: 1 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j14", workerId: "w14", durationMs: 60000 });
    h.db.prepare("INSERT INTO execution_attempts (id, job_id, worker_id, lease_id, attempt_number, started_at, status, created_at) VALUES (?,?,?,?,1,?,?,0)")
      .run("a14", "j14", "w14", c.lease!.leaseId, Date.now() - 60000, "RUNNING");
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id=?").run("j14");
    h.store.requestCancellation("j14");
    expireLease(h.db, "j14");
    h.pushExpired("j14", c.lease!.leaseId, "w14");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j14").status === "CANCELLED", "144-14 CANCELLATION wins over timeout");
    ok(countRecoveryOps(h.db, "j14", "TIMEOUT") === 0, "144-14 no TIMEOUT op created");
  }

  console.log("\n144-15 timeout goes RUNNING -> FAILED -> RETRY_SCHEDULED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j15", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 }, timeoutMs: 1 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j15", workerId: "w15", durationMs: 60000 });
    h.db.prepare("INSERT INTO execution_attempts (id, job_id, worker_id, lease_id, attempt_number, started_at, status, created_at) VALUES (?,?,?,?,1,?,?,0)")
      .run("a15", "j15", "w15", c.lease!.leaseId, Date.now() - 60000, "RUNNING");
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id=?").run("j15");
    expireLease(h.db, "j15");
    h.pushExpired("j15", c.lease!.leaseId, "w15");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j15").status === "RETRY_SCHEDULED", "144-15 status RETRY_SCHEDULED");
    ok(countEvents(h.db, "j15", "execution.recovery.failed") === 1, "144-15 one failed event");
    ok(countEvents(h.db, "j15", "execution.recovery.rerouted") === 1, "144-15 one rerouted event");
    ok(countObligations(h.db, "j15") === 1, "144-15 one obligation");
    const op = getRecoveryOp(h.db, "j15", "TIMEOUT");
    ok(!!op && op.state === "COMPLETED", "144-15 TIMEOUT op COMPLETED");
  }

  console.log("\n144-16 timeout without retry policy goes to DEAD_LETTER");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j16", { timeoutMs: 1 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j16", workerId: "w16", durationMs: 60000 });
    h.db.prepare("INSERT INTO execution_attempts (id, job_id, worker_id, lease_id, attempt_number, started_at, status, created_at) VALUES (?,?,?,?,1,?,?,0)")
      .run("a16", "j16", "w16", c.lease!.leaseId, Date.now() - 60000, "RUNNING");
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id=?").run("j16");
    expireLease(h.db, "j16");
    h.pushExpired("j16", c.lease!.leaseId, "w16");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j16").status === "DEAD_LETTER", "144-16 status DEAD_LETTER");
    const op = getRecoveryOp(h.db, "j16", "TIMEOUT");
    ok(!!op && op.state === "COMPLETED", "144-16 TIMEOUT op COMPLETED");
  }

  console.log("\n144-17 timeout crash after FAILED resumes on restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "p144-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j17", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
      const c = h1.store.atomicClaimJob({ jobId: "j17", workerId: "w17", durationMs: 60000 });
      // Simulate: step1 FAILED succeeded, step2 never ran, process died.
      h1.db.prepare("UPDATE execution_jobs SET status='FAILED', current_lease_id=NULL WHERE id='j17'").run();
      h1.store.recoveryOps.createOrGetOperation({ jobId: "j17", leaseId: c.lease!.leaseId, workerId: "w17", operationType: "TIMEOUT" });
      h1.db.close();

      const h2 = makeEngineHarness(dbFile, "e2");
      h2.engine.reconcileExecutionRecoveryOperations();
      ok(getJob(h2.db, "j17").status === "RETRY_SCHEDULED", "144-17 step2 completed after restart");
      const op = getRecoveryOp(h2.db, "j17", "TIMEOUT");
      ok(op.state === "COMPLETED", "144-17 TIMEOUT op COMPLETED");
      ok(countEvents(h2.db, "j17", "execution.recovery.failed") === 0, "144-17 no duplicate FAILED event");
      ok(countEvents(h2.db, "j17", "execution.recovery.rerouted") === 1, "144-17 exactly one rerouted event");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n144-18 orphan recovery: RUNNING -> ORPHANED -> QUEUED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j18", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    const c = h.store.atomicClaimJob({ jobId: "j18", workerId: "w18", durationMs: 60000 });
    expireLease(h.db, "j18");
    h.pushExpired("j18", c.lease!.leaseId, "w18");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j18").status === "QUEUED", "144-18 QUEUED");
    ok(countObligations(h.db, "j18") === 1, "144-18 one obligation");
    ok(countEvents(h.db, "j18", "execution.recovery.orphaned") === 1, "144-18 one orphaned event");
    ok(countEvents(h.db, "j18", "execution.recovery.requeued") === 1, "144-18 one requeued event");
    const op = getRecoveryOp(h.db, "j18", "ORPHAN_RECOVERY");
    ok(!!op && op.state === "COMPLETED", "144-18 ORPHAN_RECOVERY op COMPLETED");
  }

  console.log("\n144-19 orphan crash after ORPHANED resumes on restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "p144-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j19", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
      const c = h1.store.atomicClaimJob({ jobId: "j19", workerId: "w19", durationMs: 60000 });
      // Simulate step1 ORPHANED done, step2 never ran.
      h1.store.recoverJobAtomic({
        jobId: "j19", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
        expectedLeaseId: c.lease!.leaseId,
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: c.lease!.leaseId, workerId: "w19", reason: "LEASE_EXPIRED" },
      });
      h1.store.recoveryOps.createOrGetOperation({ jobId: "j19", leaseId: c.lease!.leaseId, workerId: "w19", operationType: "ORPHAN_RECOVERY" });
      h1.db.close();

      const h2 = makeEngineHarness(dbFile, "e2");
      h2.engine.reconcileExecutionRecoveryOperations();
      ok(getJob(h2.db, "j19").status === "QUEUED", "144-19 QUEUED after restart");
      ok(countObligations(h2.db, "j19") === 1, "144-19 no duplicate obligation");
      ok(countEvents(h2.db, "j19", "execution.recovery.orphaned") === 1, "144-19 one orphaned event");
      ok(countEvents(h2.db, "j19", "execution.recovery.requeued") === 1, "144-19 one requeued event");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n144-20 non-retryable orphan becomes RECOVERY_REQUIRED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j20"));
    const c = h.store.atomicClaimJob({ jobId: "j20", workerId: "w20", durationMs: 60000 });
    expireLease(h.db, "j20");
    h.pushExpired("j20", c.lease!.leaseId, "w20");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j20").status === "ORPHANED", "144-20 stays ORPHANED");
    const op = getRecoveryOp(h.db, "j20", "ORPHAN_RECOVERY");
    ok(!!op && op.state === "RECOVERY_REQUIRED", "144-20 op RECOVERY_REQUIRED");
    ok(!!op.last_error, "144-20 error evidence");
  }

  console.log("\n144-21 repeated recovery cycles converge without duplicates");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j21", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    const c = h.store.atomicClaimJob({ jobId: "j21", workerId: "w21", durationMs: 60000 });
    expireLease(h.db, "j21");
    h.pushExpired("j21", c.lease!.leaseId, "w21");
    h.engine.recoverStaleJobs();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j21").status === "QUEUED", "144-21 stable QUEUED");
    ok(countRecoveryOps(h.db, "j21", "ORPHAN_RECOVERY") === 1, "144-21 one operation row");
    ok(countObligations(h.db, "j21") === 1, "144-21 one obligation");
    ok(countEvents(h.db, "j21", "execution.recovery.orphaned") === 1, "144-21 one orphaned event");
    ok(countEvents(h.db, "j21", "execution.recovery.requeued") === 1, "144-21 one requeued event");
  }

  console.log("\n144-22 process reload preserves final state and operation");
  {
    const dir = mkdtempSync(join(tmpdir(), "p144-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j22", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
      const c = h1.store.atomicClaimJob({ jobId: "j22", workerId: "w22", durationMs: 60000 });
      expireLease(h1.db, "j22");
      h1.pushExpired("j22", c.lease!.leaseId, "w22");
      h1.engine.recoverStaleJobs();
      h1.db.close();

      const h2 = makeEngineHarness(dbFile, "e2");
      ok(getJob(h2.db, "j22").status === "QUEUED", "144-22 status durable");
      const op = getRecoveryOp(h2.db, "j22", "ORPHAN_RECOVERY");
      ok(op.state === "COMPLETED", "144-22 operation durable");
      ok(countObligations(h2.db, "j22") === 1, "144-22 obligation durable");
      ok(countEvents(h2.db, "j22", "execution.recovery.orphaned") === 1, "144-22 event durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n144-23 terminal jobs cannot be resurrected");
  {
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER"]) {
      const h = makeEngineHarness();
      h.store.createJob(queuedJob("j23-" + terminal, { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
      h.db.prepare("UPDATE execution_jobs SET status = ? WHERE id = ?").run(terminal, "j23-" + terminal);
      h.engine.recoverStaleJobs();
      h.engine.reconcileExecutionRecoveryOperations();
      ok(getJob(h.db, "j23-" + terminal).status === terminal, "144-23 " + terminal + " unchanged");
      ok(countRecoveryOps(h.db, "j23-" + terminal) === 0, "144-23 " + terminal + " no op created");
    }
  }

  console.log("\n144-24 no duplicate obligations or events");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j24", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    const c = h.store.atomicClaimJob({ jobId: "j24", workerId: "w24", durationMs: 60000 });
    expireLease(h.db, "j24");
    h.pushExpired("j24", c.lease!.leaseId, "w24");
    h.engine.recoverStaleJobs();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.recoverStaleJobs();
    ok(countObligations(h.db, "j24") === 1, "144-24 one obligation total");
    ok(countEvents(h.db, "j24", "execution.recovery.orphaned") === 1, "144-24 one orphaned event");
    ok(countEvents(h.db, "j24", "execution.recovery.requeued") === 1, "144-24 one requeued event");
    ok(countRecoveryOps(h.db, "j24", "ORPHAN_RECOVERY") === 1, "144-24 one recovery op row");
  }

  console.log("\n144-25 stale recovery cannot override a new owner");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j25", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    const old = h.store.atomicClaimJob({ jobId: "j25", workerId: "old", durationMs: 1 });
    expireLease(h.db, "j25");
    h.store.recoverJobAtomic({
      jobId: "j25", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: old.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: old.lease!.leaseId, workerId: "old", reason: "LEASE_EXPIRED" },
    });
    h.store.recoverJobAtomic({
      jobId: "j25", expectedStatus: "ORPHANED", newStatus: "QUEUED",
      expectedLeaseId: null,
      event: { eventType: "execution.recovery.requeued", payload: {} },
    });
    const fresh = h.store.atomicClaimJob({ jobId: "j25", workerId: "new", durationMs: 60000 });
    ok(fresh.claimed, "144-25 new owner claims");
    const stale = h.store.recoverJobAtomic({
      jobId: "j25", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: old.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: old.lease!.leaseId, workerId: "old", reason: "LEASE_EXPIRED" },
    });
    ok(!stale.ok, "144-25 stale recovery rejected");
    ok(getJob(h.db, "j25").current_lease_id === fresh.lease!.leaseId, "144-25 new owner lease intact");
  }

  console.log("\n144-26 concurrent execution engines converge on one operation");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j26", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    const c = h.store.atomicClaimJob({ jobId: "j26", workerId: "w26", durationMs: 60000 });
    // Pre-create the operation, unclaimed, so both engines see it.
    h.store.recoveryOps.createOrGetOperation({ jobId: "j26", leaseId: c.lease!.leaseId, workerId: "w26", operationType: "ORPHAN_RECOVERY" });
    // Simulate crash after step1 ORPHANED.
    h.store.recoverJobAtomic({
      jobId: "j26", expectedStatus: "CLAIMED", newStatus: "ORPHANED",
      expectedLeaseId: c.lease!.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: c.lease!.leaseId, workerId: "w26", reason: "LEASE_EXPIRED" },
    });

    const engineA = h.engine;
    const engineB = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});

    // Both attempt reconciliation; only one should reach QUEUED via CAS.
    engineA.reconcileExecutionRecoveryOperations();
    engineB.reconcileExecutionRecoveryOperations();
    engineA.reconcileExecutionRecoveryOperations();

    ok(getJob(h.db, "j26").status === "QUEUED", "144-26 job QUEUED");
    ok(countRecoveryOps(h.db, "j26", "ORPHAN_RECOVERY") === 1, "144-26 one op row");
    ok(countObligations(h.db, "j26") === 1, "144-26 one obligation");
    ok(countEvents(h.db, "j26", "execution.recovery.requeued") === 1, "144-26 one requeued event");
    ok(countEvents(h.db, "j26", "execution.recovery.orphaned") === 1, "144-26 one orphaned event");
  }

  console.log("\n--- Phase 144: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE144 DRIVER CRASH:", err); process.exit(1); });
