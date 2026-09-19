// scripts/test-phase145-reconciliation-integrity.ts
// Phase 145 - durable recovery reconciliation integrity.
//
// Every assertion reads durable SQLite rows. No mocks of the recovery layer.

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

interface H { db: Database.Database; store: ExecutionStore; }
function makeHarness(dbFile?: string): H {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  return { db: rawDb, store };
}

interface EngineH extends H { engine: ExecutionEngine; }
function makeEngineHarness(dbFile?: string): EngineH {
  const h = makeHarness(dbFile);
  const leaseManager: any = { recoverExpiredLeases: () => [] };
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const engine = new ExecutionEngine(h.store, workerRegistry, leaseManager, {} as any, {});
  return { ...h, engine };
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
function countEvents(db: Database.Database, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type ? (db.prepare(sql).get(jobId, type) as any).n : (db.prepare(sql).get(jobId) as any).n;
}
function countObligations(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as any).n;
}
function getRecoveryOp(db: Database.Database, jobId: string, type: string) {
  return db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ? ORDER BY created_at DESC LIMIT 1").get(jobId, type) as any;
}

function seedRecoveryOp(db: Database.Database, input: {
  operationId: string; jobId: string; leaseId: string | null; workerId: string | null;
  operationType: string; state: string; attemptCount: number; lastError?: string | null;
  claimOwner?: string | null; claimExpiresAt?: number | null;
}): void {
  const now = Date.now();
  const idem = input.operationType + ":" + input.jobId + ":" + (input.leaseId ?? "no-lease");
  db.prepare(
    "INSERT INTO execution_recovery_operations " +
    "(operation_id, job_id, lease_id, worker_id, operation_type, state, " +
    " idempotency_key, attempt_count, last_error, claim_owner, claim_expires_at, created_at, updated_at, completed_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)"
  ).run(
    input.operationId, input.jobId, input.leaseId, input.workerId, input.operationType,
    input.state, idem, input.attemptCount, input.lastError ?? null,
    input.claimOwner ?? null, input.claimExpiresAt ?? null, now, now
  );
}

async function main() {
  console.log("=== Phase 145 - Durable Recovery Reconciliation Integrity ===\n");

  console.log("145-1 FAILED op is resumed by next reconcile");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j1", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j1'").run();
    seedRecoveryOp(h.db, {
      operationId: "op1", jobId: "j1", leaseId: "L1", workerId: "w1",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 2,
      lastError: "TRANSIENT_1",
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j1").status === "QUEUED", "145-1 job QUEUED");
    ok(getRecoveryOp(h.db, "j1", "ORPHAN_RECOVERY").state === "COMPLETED", "145-1 op COMPLETED");
  }

  console.log("\n145-2 FAILED op at threshold escalates to RECOVERY_REQUIRED");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j2", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j2'").run();
    seedRecoveryOp(h.db, {
      operationId: "op2", jobId: "j2", leaseId: "L2", workerId: "w2",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 5,
      lastError: "TRANSIENT_REPEATED",
    });
    h.engine.reconcileExecutionRecoveryOperations();
    const op = getRecoveryOp(h.db, "j2", "ORPHAN_RECOVERY");
    ok(op.state === "RECOVERY_REQUIRED", "145-2 op RECOVERY_REQUIRED");
    ok(op.last_error && op.last_error.indexOf("MAX_RECOVERY_ATTEMPTS_EXCEEDED") === 0, "145-2 diagnostic error");
    ok(op.last_error.indexOf("TRANSIENT_REPEATED") > 0, "145-2 prior error preserved");
    ok(getJob(h.db, "j2").status === "ORPHANED", "145-2 job unchanged");
  }

  console.log("\n145-3 live claim not stolen by reconcile");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j3", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j3'").run();
    const future = Date.now() + 60000;
    seedRecoveryOp(h.db, {
      operationId: "op3", jobId: "j3", leaseId: "L3", workerId: "w3",
      operationType: "ORPHAN_RECOVERY", state: "CLAIMED", attemptCount: 1,
      claimOwner: "live-owner", claimExpiresAt: future,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    const op = getRecoveryOp(h.db, "j3", "ORPHAN_RECOVERY");
    ok(op.state === "CLAIMED", "145-3 still CLAIMED");
    ok(op.claim_owner === "live-owner", "145-3 owner unchanged");
    ok(getJob(h.db, "j3").status === "ORPHANED", "145-3 job unchanged");
  }

  console.log("\n145-4 stale owner cannot finalize after reclaim");
  {
    const h = makeHarness();
    const past = Date.now() - 1000;
    seedRecoveryOp(h.db, {
      operationId: "op4", jobId: "j4", leaseId: "L4", workerId: "w4",
      operationType: "ORPHAN_RECOVERY", state: "CLAIMED", attemptCount: 1,
      claimOwner: "old-owner", claimExpiresAt: past,
    });
    const ops = h.store.recoveryOps;
    const reclaim = ops.claimOperation({ operationId: "op4", owner: "new-owner", durationMs: 60000 });
    ok(reclaim.claimed, "145-4 new-owner reclaims");
    const staleMark = ops.markCompleted("op4", "old-owner");
    ok(!staleMark, "145-4 stale owner rejected");
    const marked = ops.markCompleted("op4", "new-owner");
    ok(marked, "145-4 new owner succeeds");
    const op = getRecoveryOp(h.db, "j4", "ORPHAN_RECOVERY");
    ok(op.state === "COMPLETED", "145-4 op COMPLETED");
    ok(op.claim_owner === null, "145-4 claim cleared");
  }

  console.log("\n145-5 job already in target: op finalized without rerun");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j5"));
    h.db.prepare("UPDATE execution_jobs SET status='QUEUED' WHERE id='j5'").run();
    seedRecoveryOp(h.db, {
      operationId: "op5", jobId: "j5", leaseId: "L5", workerId: "w5",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 1,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getRecoveryOp(h.db, "j5", "ORPHAN_RECOVERY").state === "COMPLETED", "145-5 op COMPLETED");
    ok(countEvents(h.db, "j5", "execution.recovery.requeued") === 0, "145-5 no dup requeue event");
    ok(countObligations(h.db, "j5") === 0, "145-5 no spurious obligation");
  }

  console.log("\n145-6 repeated reconcile converges without duplicates");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j6", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j6'").run();
    seedRecoveryOp(h.db, {
      operationId: "op6", jobId: "j6", leaseId: "L6", workerId: "w6",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 2,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j6").status === "QUEUED", "145-6 job QUEUED");
    ok(getRecoveryOp(h.db, "j6", "ORPHAN_RECOVERY").state === "COMPLETED", "145-6 op COMPLETED");
    ok(countEvents(h.db, "j6", "execution.recovery.requeued") === 1, "145-6 one requeue event");
    ok(countObligations(h.db, "j6") === 0, "145-6 no spurious obligation");
  }

  console.log("\n145-7 crash between claim and body resumes");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j7", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j7'").run();
    const past = Date.now() - 1000;
    seedRecoveryOp(h.db, {
      operationId: "op7", jobId: "j7", leaseId: "L7", workerId: "w7",
      operationType: "ORPHAN_RECOVERY", state: "CLAIMED", attemptCount: 1,
      claimOwner: "dead", claimExpiresAt: past,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j7").status === "QUEUED", "145-7 resumed to QUEUED");
    ok(getRecoveryOp(h.db, "j7", "ORPHAN_RECOVERY").state === "COMPLETED", "145-7 op COMPLETED");
  }

  console.log("\n145-8 two engines reconcile concurrently");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j8", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j8'").run();
    seedRecoveryOp(h.db, {
      operationId: "op8", jobId: "j8", leaseId: "L8", workerId: "w8",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 1,
    });
    const engine2 = new ExecutionEngine(
      h.store,
      { detectLostWorkers: () => [] } as any,
      { recoverExpiredLeases: () => [] } as any,
      {} as any,
      {}
    );
    h.engine.reconcileExecutionRecoveryOperations();
    engine2.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getJob(h.db, "j8").status === "QUEUED", "145-8 job QUEUED");
    ok(countEvents(h.db, "j8", "execution.recovery.requeued") === 1, "145-8 one requeue event");
    ok(countObligations(h.db, "j8") === 0, "145-8 no spurious obligation");
  }

  console.log("\n145-9 CANCELLATION: already CANCELLED job finalized without rerun");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j9"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='j9'").run();
    seedRecoveryOp(h.db, {
      operationId: "op9", jobId: "j9", leaseId: "L9", workerId: "w9",
      operationType: "CANCELLATION", state: "FAILED", attemptCount: 1,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getRecoveryOp(h.db, "j9", "CANCELLATION").state === "COMPLETED", "145-9 op COMPLETED");
    ok(countEvents(h.db, "j9", "execution.recovery.cancelled") === 0, "145-9 no dup cancelled event");
  }

  console.log("\n145-10 TIMEOUT: already RETRY_SCHEDULED job finalized without rerun");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j10"));
    h.db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED' WHERE id='j10'").run();
    seedRecoveryOp(h.db, {
      operationId: "op10", jobId: "j10", leaseId: "L10", workerId: "w10",
      operationType: "TIMEOUT", state: "FAILED", attemptCount: 1,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getRecoveryOp(h.db, "j10", "TIMEOUT").state === "COMPLETED", "145-10 op COMPLETED");
    ok(countEvents(h.db, "j10", "execution.recovery.rerouted") === 0, "145-10 no dup rerouted event");
  }

  console.log("\n145-11 ORPHAN_RECOVERY: already QUEUED job finalized without rerun");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j11"));
    h.db.prepare("UPDATE execution_jobs SET status='QUEUED' WHERE id='j11'").run();
    seedRecoveryOp(h.db, {
      operationId: "op11", jobId: "j11", leaseId: "L11", workerId: "w11",
      operationType: "ORPHAN_RECOVERY", state: "FAILED", attemptCount: 1,
    });
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getRecoveryOp(h.db, "j11", "ORPHAN_RECOVERY").state === "COMPLETED", "145-11 op COMPLETED");
    ok(countEvents(h.db, "j11", "execution.recovery.requeued") === 0, "145-11 no dup requeued event");
  }

  console.log("\n145-12 RECOVERY_REQUIRED stays excluded from auto-reconcile");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j12", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as any }));
    h.db.prepare("UPDATE execution_jobs SET status='ORPHANED' WHERE id='j12'").run();
    seedRecoveryOp(h.db, {
      operationId: "op12", jobId: "j12", leaseId: "L12", workerId: "w12",
      operationType: "ORPHAN_RECOVERY", state: "RECOVERY_REQUIRED", attemptCount: 3,
      lastError: "OPERATOR_ATTENTION",
    });
    h.engine.reconcileExecutionRecoveryOperations();
    const op = getRecoveryOp(h.db, "j12", "ORPHAN_RECOVERY");
    ok(op.state === "RECOVERY_REQUIRED", "145-12 op still RECOVERY_REQUIRED");
    ok(getJob(h.db, "j12").status === "ORPHANED", "145-12 job unchanged");
    ok(op.attempt_count === 3, "145-12 attempt_count unchanged");
  }

  console.log("\n--- Phase 145: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE145 DRIVER CRASH:", err); process.exit(1); });
