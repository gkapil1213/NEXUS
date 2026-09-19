// scripts/test-phase146-retry-budget-recovery.ts
// Phase 146 - recovery-path retry budget enforcement.
//
// The live executeJob path bounds retries via RetryEngine.calculateNextAttempt,
// which returns null once attempts consumed >= maxAttempts. The recovery paths
// historically substituted a weaker proxy (!!retryPolicy && canTransition), so
// a job that had already consumed its retry budget could be resurrected by
// lease-loss recovery and run attempts beyond maxAttempts.
//
// Every assertion reads durable SQLite rows.

import Database from "better-sqlite3";
import { join } from "path";
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

interface EngineH {
  db: Database.Database;
  store: ExecutionStore;
  engine: ExecutionEngine;
  pushExpired(jobId: string, leaseId: string, workerId: string): void;
}

function makeEngineHarness(dbFile?: string): EngineH {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const queue: Array<{ jobId: string; leaseId: string; workerId: string; expiresAt: number }> = [];
  const leaseManager: any = {
    recoverExpiredLeases: (_now: number) => { const out = queue.slice(); queue.length = 0; return out; },
  };
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const engine = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {});
  return {
    db: rawDb, store, engine,
    pushExpired: (jobId, leaseId, workerId) => queue.push({ jobId, leaseId, workerId, expiresAt: Date.now() - 1000 }),
  };
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

function getJob(db: Database.Database, id: string) {
  return db.prepare("SELECT status, current_lease_id FROM execution_jobs WHERE id = ?").get(id) as any;
}
function countAttempts(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get(jobId) as any).n;
}
function countEvents(db: Database.Database, jobId: string, type: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?").get(jobId, type) as any).n;
}
function insertAttempt(db: Database.Database, input: {
  id: string; jobId: string; attemptNumber: number; leaseId: string; workerId: string;
  startedAt: number; status: string;
}): void {
  db.prepare(
    "INSERT INTO execution_attempts " +
    "(id, job_id, worker_id, lease_id, attempt_number, started_at, status, created_at) " +
    "VALUES (?,?,?,?,?,?,?,?)"
  ).run(input.id, input.jobId, input.workerId, input.leaseId, input.attemptNumber,
        input.startedAt, input.status, Date.now());
}
function expireLease(db: Database.Database, jobId: string): string {
  const lease = db.prepare("SELECT lease_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'").get(jobId) as any;
  if (!lease) throw new Error("no active lease for " + jobId);
  db.prepare("UPDATE execution_leases SET status = 'EXPIRED', expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, lease.lease_id);
  return lease.lease_id;
}

async function main() {
  console.log("=== Phase 146 - Recovery-Path Retry Budget Enforcement ===\n");

  console.log("146-1 timeout recovery with exhausted budget routes DEAD_LETTER");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j1", {
      retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
      timeoutMs: 1000,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j1", workerId: "w1", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j1'").run();
    const past = Date.now() - 60000;
    insertAttempt(h.db, { id: "a1", jobId: "j1", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w1", startedAt: past, status: "RUNNING" });
    insertAttempt(h.db, { id: "a2", jobId: "j1", attemptNumber: 2, leaseId: c.lease!.leaseId, workerId: "w1", startedAt: past, status: "RUNNING" });
    expireLease(h.db, "j1");
    h.pushExpired("j1", c.lease!.leaseId, "w1");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j1").status === "DEAD_LETTER", "146-1 job DEAD_LETTER (budget exhausted)");
    ok(getJob(h.db, "j1").status !== "RETRY_SCHEDULED", "146-1 NOT RETRY_SCHEDULED");
    ok(countAttempts(h.db, "j1") === 2, "146-1 still 2 attempts, no attempt 3");
  }

  console.log("\n146-2 orphan recovery with exhausted budget routes RECOVERY_REQUIRED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j2", {
      retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j2", workerId: "w2", durationMs: 60000 });
    insertAttempt(h.db, { id: "b1", jobId: "j2", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w2", startedAt: Date.now() - 60000, status: "RUNNING" });
    insertAttempt(h.db, { id: "b2", jobId: "j2", attemptNumber: 2, leaseId: c.lease!.leaseId, workerId: "w2", startedAt: Date.now() - 60000, status: "RUNNING" });
    expireLease(h.db, "j2");
    h.pushExpired("j2", c.lease!.leaseId, "w2");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j2").status === "ORPHANED", "146-2 job stays ORPHANED");
    const op = h.db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = 'ORPHAN_RECOVERY'").get("j2") as any;
    ok(!!op && op.state === "RECOVERY_REQUIRED", "146-2 op RECOVERY_REQUIRED");
    ok(!!op && op.last_error === "NON_RETRYABLE_ORPHAN", "146-2 diagnostic NON_RETRYABLE_ORPHAN");
  }

  console.log("\n146-3 timeout recovery within budget routes RETRY_SCHEDULED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j3", {
      retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
      timeoutMs: 1000,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j3", workerId: "w3", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j3'").run();
    insertAttempt(h.db, { id: "c1", jobId: "j3", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w3", startedAt: Date.now() - 60000, status: "RUNNING" });
    expireLease(h.db, "j3");
    h.pushExpired("j3", c.lease!.leaseId, "w3");
    h.engine.recoverStaleJobs();
    // Phase 147 (commit 2c8aa91): a recovery operation that routes to
    // RETRY_SCHEDULED with nextAttemptAt === now is promoted to QUEUED by
    // promoteImmediateRecoveryRetries within the same recoverStaleJobs tick.
    // The Phase 146 invariant this test guards is that the retry was ALLOWED
    // because 1 < maxAttempts (not routed to DEAD_LETTER) and that exactly one
    // execution.recovery.rerouted event was emitted. RETRY_SCHEDULED is now
    // an intermediate state, not the final persisted state.
    const j3Row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j3'").get() as any;
    ok(j3Row.status === "QUEUED", "146-3 QUEUED (retry allowed, 1 < 3, promoted same tick)");
    ok(j3Row.status !== "DEAD_LETTER", "146-3 not DEAD_LETTER");
    ok(j3Row.next_attempt_at === null, "146-3 next_attempt_at consumed");
    ok(countEvents(h.db, "j3", "execution.recovery.rerouted") === 1, "146-3 one rerouted event");
  }

  console.log("\n146-4 orphan recovery within budget routes QUEUED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j4", {
      retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j4", workerId: "w4", durationMs: 60000 });
    insertAttempt(h.db, { id: "d1", jobId: "j4", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w4", startedAt: Date.now() - 60000, status: "RUNNING" });
    expireLease(h.db, "j4");
    h.pushExpired("j4", c.lease!.leaseId, "w4");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j4").status === "QUEUED", "146-4 QUEUED (1 < 3)");
    ok(countEvents(h.db, "j4", "execution.recovery.requeued") === 1, "146-4 one requeued event");
  }

  console.log("\n146-5 no retry policy still routes RECOVERY_REQUIRED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j5"));
    const c = h.store.atomicClaimJob({ jobId: "j5", workerId: "w5", durationMs: 60000 });
    expireLease(h.db, "j5");
    h.pushExpired("j5", c.lease!.leaseId, "w5");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j5").status === "ORPHANED", "146-5 stays ORPHANED");
    const op = h.db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = 'ORPHAN_RECOVERY'").get("j5") as any;
    ok(!!op && op.state === "RECOVERY_REQUIRED", "146-5 op RECOVERY_REQUIRED");
  }

  console.log("\n146-6 zero attempts, budget available: recovery allowed");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j6", {
      retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j6", workerId: "w6", durationMs: 60000 });
    // No attempt rows at all - simulated crash after CLAIM but before RUNNING.
    expireLease(h.db, "j6");
    h.pushExpired("j6", c.lease!.leaseId, "w6");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j6").status === "QUEUED", "146-6 QUEUED (0 < 3)");
    ok(countAttempts(h.db, "j6") === 0, "146-6 still 0 attempts");
  }

  console.log("\n146-7 repeated recovery after DEAD_LETTER converges without resurrection");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j7", {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
      timeoutMs: 1000,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j7", workerId: "w7", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j7'").run();
    insertAttempt(h.db, { id: "e1", jobId: "j7", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w7", startedAt: Date.now() - 60000, status: "RUNNING" });
    expireLease(h.db, "j7");
    h.pushExpired("j7", c.lease!.leaseId, "w7");
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j7").status === "DEAD_LETTER", "146-7 first recovery -> DEAD_LETTER");
    h.engine.recoverStaleJobs();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j7").status === "DEAD_LETTER", "146-7 stays DEAD_LETTER");
    ok(countEvents(h.db, "j7", "execution.recovery.rerouted") === 1, "146-7 one rerouted event total");
  }

  console.log("\n146-8 concurrent engines still produce one authoritative recovery");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j8", {
      retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any,
      timeoutMs: 1000,
    } as any));
    const c = h.store.atomicClaimJob({ jobId: "j8", workerId: "w8", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j8'").run();
    insertAttempt(h.db, { id: "f1", jobId: "j8", attemptNumber: 1, leaseId: c.lease!.leaseId, workerId: "w8", startedAt: Date.now() - 60000, status: "RUNNING" });
    insertAttempt(h.db, { id: "f2", jobId: "j8", attemptNumber: 2, leaseId: c.lease!.leaseId, workerId: "w8", startedAt: Date.now() - 60000, status: "RUNNING" });
    expireLease(h.db, "j8");
    h.pushExpired("j8", c.lease!.leaseId, "w8");
    const engine2 = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engine.recoverStaleJobs();
    engine2.recoverStaleJobs();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j8").status === "DEAD_LETTER", "146-8 DEAD_LETTER");
    ok(countEvents(h.db, "j8", "execution.recovery.rerouted") === 1, "146-8 one rerouted event");
  }

  console.log("\n--- Phase 146: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE146 DRIVER CRASH:", err); process.exit(1); });
