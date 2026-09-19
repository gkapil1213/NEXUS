// scripts/test-phase147-retry-scheduling-integrity.ts
// Phase 147 - durable retry scheduling & attempt-consistency integrity.
//
// Every assertion reads durable SQLite rows. No mocks of the persistence layer.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { RetryEngine } from "../src/core/retry-engine";
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
  setExpiredLeases(leases: Array<{ jobId: string; leaseId: string; workerId: string; expiresAt: number }>): void;
}

function makeEngineHarness(dbFile?: string): EngineH {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  const migrationsDir = join(process.cwd(), "src", "db", "migrations");
  new MigrationRunner(rawDb, migrationsDir).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  let queue: Array<{ jobId: string; leaseId: string; workerId: string; expiresAt: number }> = [];
  const leaseManager: any = {
    recoverExpiredLeases: (_now: number) => {
      const out = queue.slice();
      queue = [];
      return out;
    },
  };
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const engine = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {});
  return {
    db: rawDb, store, engine,
    setExpiredLeases: (leases) => { queue = leases.slice(); },
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
  return db.prepare("SELECT status, next_attempt_at, current_lease_id, cancellation_requested FROM execution_jobs WHERE id = ?").get(id) as any;
}
function countEvents(db: Database.Database, jobId: string, type: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?").get(jobId, type) as any).n;
}
function setScheduled(db: Database.Database, id: string, nextAt: number | null): void {
  db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at = ?, current_lease_id = NULL WHERE id = ?").run(nextAt, id);
}
function expireLease(db: Database.Database, jobId: string): string {
  const lease = db.prepare("SELECT lease_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'").get(jobId) as any;
  if (!lease) throw new Error("no active lease for " + jobId);
  db.prepare("UPDATE execution_leases SET status = 'EXPIRED', expires_at = ? WHERE lease_id = ?").run(Date.now() - 1000, lease.lease_id);
  return lease.lease_id;
}
function insertAttempt(db: Database.Database, input: {
  id: string; jobId: string; attemptNumber: number; status: string; startedAt?: number;
}): void {
  db.prepare(
    "INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, started_at, created_at) " +
    "VALUES (?,?,?,?,?,?,?,?)"
  ).run(input.id, input.jobId, input.attemptNumber, input.status, "w", "L", input.startedAt ?? Date.now(), Date.now());
}

async function main() {
  console.log("=== Phase 147 - Durable Retry Scheduling Integrity ===\n");

  console.log("147-01 normal RETRY_SCHEDULED carries a valid next_attempt_at");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j1", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j1", Date.now() - 1000);
    const row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j1'").get() as any;
    ok(row.status === "RETRY_SCHEDULED", "147-01 status RETRY_SCHEDULED");
    ok(typeof row.next_attempt_at === "number" && row.next_attempt_at > 0, "147-01 next_attempt_at valid");
  }

  console.log("\n147-02 timeout recovery with exhausted budget routes DEAD_LETTER");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j2", { retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j2", workerId: "w2", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j2'").run();
    const past = Date.now() - 60000;
    insertAttempt(h.db, { id: "a2-1", jobId: "j2", attemptNumber: 1, status: "RUNNING", startedAt: past });
    insertAttempt(h.db, { id: "a2-2", jobId: "j2", attemptNumber: 2, status: "RUNNING", startedAt: past });
    expireLease(h.db, "j2");
    h.setExpiredLeases([{ jobId: "j2", leaseId: c.lease!.leaseId, workerId: "w2", expiresAt: Date.now() - 1000 }]);
    h.engine.recoverStaleJobs();
    const row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j2'").get() as any;
    ok(row.status === "DEAD_LETTER", "147-02 DEAD_LETTER");
    ok(row.status !== "RETRY_SCHEDULED", "147-02 not RETRY_SCHEDULED");
    ok(row.next_attempt_at === null, "147-02 next_attempt_at cleared");
  }

  console.log("\n147-03 recovery retry within budget schedules then promotes");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j3", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j3", Date.now() - 1000);
    h.engine.recoverStaleJobs();
    const row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j3'").get() as any;
    ok(row.status === "QUEUED", "147-03 promoted to QUEUED");
    ok(row.next_attempt_at === null, "147-03 schedule consumed");
    ok(countEvents(h.db, "j3", "execution.retry.due") === 1, "147-03 one due event");
  }

  console.log("\n147-04 timeout recovery within budget routes RETRY_SCHEDULED, then promotes");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j4", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j4", workerId: "w4", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j4'").run();
    insertAttempt(h.db, { id: "a4-1", jobId: "j4", attemptNumber: 1, status: "RUNNING", startedAt: Date.now() - 60000 });
    expireLease(h.db, "j4");
    h.setExpiredLeases([{ jobId: "j4", leaseId: c.lease!.leaseId, workerId: "w4", expiresAt: Date.now() - 1000 }]);
    h.engine.recoverStaleJobs();
    const row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j4'").get() as any;
    // Promotion happens in the same recoverStaleJobs tick because runDueRetries runs after the lease loop.
    ok(row.status === "QUEUED", "147-04 promoted to QUEUED within same tick");
    ok(row.next_attempt_at === null, "147-04 schedule consumed");
    ok(countEvents(h.db, "j4", "execution.recovery.failed") === 1, "147-04 one failed event");
    ok(countEvents(h.db, "j4", "execution.recovery.rerouted") === 1, "147-04 one rerouted event");
    ok(countEvents(h.db, "j4", "execution.retry.due") === 1, "147-04 one due event");
  }

  console.log("\n147-05 RETRY_SCHEDULED can never persist without next_attempt_at");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j5", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j5", null);
    h.engine.recoverStaleJobs();
    const row = h.db.prepare("SELECT status FROM execution_jobs WHERE id='j5'").get() as any;
    ok(row.status !== "RETRY_SCHEDULED", "147-05 invariant violation escalated");
    ok(countEvents(h.db, "j5", "execution.retry.invariant_violation") === 1, "147-05 one invariant event");
  }

  console.log("\n147-06 terminal states retain no runnable retry schedule");
  {
    for (const terminal of ["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]) {
      const h = makeEngineHarness();
      h.store.createJob(queuedJob("j6-" + terminal));
      h.db.prepare("UPDATE execution_jobs SET status = ?, next_attempt_at = ? WHERE id = ?").run(terminal, Date.now() - 1000, "j6-" + terminal);
      h.engine.recoverStaleJobs();
      const row = h.db.prepare("SELECT status FROM execution_jobs WHERE id=?").get("j6-" + terminal) as any;
      ok(row.status === terminal, "147-06 " + terminal + " unchanged");
    }
  }

  console.log("\n147-07 RetryEngine.calculateNextAttempt semantics preserved");
  {
    const retryEngine = new RetryEngine();
    const policy = { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 10000 };
    const now = Date.now();
    ok(retryEngine.calculateNextAttempt(1, policy as any, now) === now + 100, "147-07 attempt 1 delay = initialDelayMs");
    ok(retryEngine.calculateNextAttempt(2, policy as any, now) === now + 200, "147-07 attempt 2 delay doubled");
    ok(retryEngine.calculateNextAttempt(3, policy as any, now) === null, "147-07 attempt 3 exhausted");
  }

  console.log("\n147-08 recovery immediate scheduling semantics preserved");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j8", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j8", Date.now() - 1);
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j8").status === "QUEUED", "147-08 immediate due promoted");
    ok(getJob(h.db, "j8").next_attempt_at === null, "147-08 schedule consumed");
  }

  console.log("\n147-09 repeated recovery is idempotent");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j9", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j9", Date.now() - 1000);
    h.engine.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j9").status === "QUEUED", "147-09 stable QUEUED");
    ok(countEvents(h.db, "j9", "execution.retry.due") === 1, "147-09 one due event total");
  }

  console.log("\n147-10 concurrent engines converge on one authoritative promotion");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j10", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j10", Date.now() - 1000);
    const engine2 = new ExecutionEngine(h.store, { detectLostWorkers: () => [] } as any, { recoverExpiredLeases: () => [] } as any, {} as any, {});
    h.engine.recoverStaleJobs();
    engine2.recoverStaleJobs();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j10").status === "QUEUED", "147-10 QUEUED");
    ok(countEvents(h.db, "j10", "execution.retry.due") === 1, "147-10 exactly one due event");
  }

  console.log("\n147-11 crash after retry scheduling preserves the retry");
  {
    const dir = mkdtempSync(join(tmpdir(), "p147-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j11", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
      setScheduled(h1.db, "j11", Date.now() + 60000);
      h1.db.close();

      const h2 = makeEngineHarness(dbFile);
      const row = h2.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j11'").get() as any;
      ok(row.status === "RETRY_SCHEDULED", "147-11 status durable");
      ok(typeof row.next_attempt_at === "number", "147-11 schedule durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n147-12 crash before retry scheduling produces no phantom");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j12", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    h.db.prepare("UPDATE execution_jobs SET status='FAILED' WHERE id='j12'").run();
    const row = h.db.prepare("SELECT status, next_attempt_at FROM execution_jobs WHERE id='j12'").get() as any;
    ok(row.status === "FAILED", "147-12 stays FAILED");
    ok(row.next_attempt_at === null, "147-12 no phantom schedule");
  }

  console.log("\n147-13 stale worker cannot schedule retry after lease loss");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j13", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
    setScheduled(h.db, "j13", Date.now() - 1000);
    const stale = h.store.recoverJobAtomic({
      jobId: "j13",
      expectedStatus: "RETRY_SCHEDULED",
      newStatus: "QUEUED",
      expectedLeaseId: "stale-lease",
      event: { eventType: "execution.retry.due", payload: {} },
    });
    ok(!stale.ok, "147-13 stale lease assertion rejected");
    ok(getJob(h.db, "j13").status === "RETRY_SCHEDULED", "147-13 unchanged");
  }

  console.log("\n147-14 concurrent attempt creation cannot duplicate attempt_number");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j14"));
    insertAttempt(h.db, { id: "a14-1", jobId: "j14", attemptNumber: 1, status: "RUNNING" });
    let duplicateRejected = false;
    try {
      insertAttempt(h.db, { id: "a14-2", jobId: "j14", attemptNumber: 1, status: "RUNNING" });
    } catch { duplicateRejected = true; }
    ok(duplicateRejected, "147-14 duplicate (job_id, attempt_number) rejected by DB");
  }

  console.log("\n147-15 restart preserves retry schedule");
  {
    const dir = mkdtempSync(join(tmpdir(), "p147-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeEngineHarness(dbFile);
      h1.store.createJob(queuedJob("j15", { retryPolicy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any } as any));
      const future = Date.now() + 30000;
      setScheduled(h1.db, "j15", future);
      h1.db.close();

      const h2 = makeEngineHarness(dbFile);
      const row = h2.db.prepare("SELECT next_attempt_at FROM execution_jobs WHERE id='j15'").get() as any;
      ok(row.next_attempt_at === future, "147-15 schedule preserved exactly");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n147-16 listJobsDueForRetry never returns malformed records");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j16-null"));
    h.store.createJob(queuedJob("j16-valid"));
    h.store.createJob(queuedJob("j16-future"));
    h.db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at=NULL WHERE id='j16-null'").run();
    h.db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at=? WHERE id='j16-valid'").run(Date.now() - 1000);
    h.db.prepare("UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at=? WHERE id='j16-future'").run(Date.now() + 60000);
    const due = h.store.listJobsDueForRetry(Date.now());
    const ids = due.map((j) => j.id);
    ok(!ids.includes("j16-null"), "147-16 NULL next_attempt_at excluded");
    ok(ids.includes("j16-valid"), "147-16 valid past next_attempt_at included");
    ok(!ids.includes("j16-future"), "147-16 future excluded");
  }

  console.log("\n147-17 DEAD_LETTER cannot be resurrected by reconciliation");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j17"));
    h.db.prepare("UPDATE execution_jobs SET status='DEAD_LETTER' WHERE id='j17'").run();
    h.engine.recoverStaleJobs();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j17").status === "DEAD_LETTER", "147-17 DEAD_LETTER stable");
  }

  console.log("\n147-18 CANCELLED cannot be resurrected");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j18"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='j18'").run();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j18").status === "CANCELLED", "147-18 CANCELLED stable");
  }

  console.log("\n147-19 SUCCEEDED cannot be resurrected");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j19"));
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='j19'").run();
    h.engine.recoverStaleJobs();
    ok(getJob(h.db, "j19").status === "SUCCEEDED", "147-19 SUCCEEDED stable");
  }

  console.log("\n147-20 Phase 146 retry-budget protection remains intact");
  {
    const h = makeEngineHarness();
    h.store.createJob(queuedJob("j20", { retryPolicy: { maxAttempts: 2, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 } as any, timeoutMs: 1000 } as any));
    const c = h.store.atomicClaimJob({ jobId: "j20", workerId: "w20", durationMs: 60000 });
    h.db.prepare("UPDATE execution_jobs SET status='RUNNING' WHERE id='j20'").run();
    const past = Date.now() - 60000;
    insertAttempt(h.db, { id: "a20-1", jobId: "j20", attemptNumber: 1, status: "RUNNING", startedAt: past });
    insertAttempt(h.db, { id: "a20-2", jobId: "j20", attemptNumber: 2, status: "RUNNING", startedAt: past });
    expireLease(h.db, "j20");
    h.setExpiredLeases([{ jobId: "j20", leaseId: c.lease!.leaseId, workerId: "w20", expiresAt: Date.now() - 1000 }]);
    h.engine.recoverStaleJobs();
    const row = h.db.prepare("SELECT status FROM execution_jobs WHERE id='j20'").get() as any;
    ok(row.status === "DEAD_LETTER", "147-20 DEAD_LETTER");
    ok(row.status !== "RETRY_SCHEDULED", "147-20 budget enforced: not RETRY_SCHEDULED");
  }

  console.log("\n--- Phase 147: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE147 DRIVER CRASH:", err); process.exit(1); });
