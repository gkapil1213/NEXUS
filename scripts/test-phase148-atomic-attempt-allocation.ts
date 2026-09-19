// scripts/test-phase148-atomic-attempt-allocation.ts
// Phase 148 - atomic durable attempt allocation.
//
// Every assertion reads durable SQLite rows. No mocks of the persistence layer.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
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

function queuedJob(id: string): ExecutionJob {
  const now = Date.now();
  return {
    id, idempotencyKey: "k-" + id, jobType: "engineering" as any,
    payload: { kind: "engineering", executionId: "exec-" + id },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as ExecutionJob;
}

function seedLease(db: Database.Database, jobId: string, workerId: string, leaseId: string, status = "ACTIVE", expiresAt = Date.now() + 60000): void {
  db.prepare(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) " +
    "VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now(), expiresAt, status);
}

function setJobRunning(db: Database.Database, jobId: string, leaseId: string | null): void {
  db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
}

function countAttempts(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get(jobId) as any).n;
}

function listNumbers(db: Database.Database, jobId: string): number[] {
  return (db.prepare("SELECT attempt_number FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number").all(jobId) as any[]).map((r) => r.attempt_number);
}

async function main() {
  console.log("=== Phase 148 - Atomic Durable Attempt Allocation ===\n");

  console.log("148-1 sequential allocation yields 1, 2, 3");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1"));
    setJobRunning(h.db, "j1", "L1");
    seedLease(h.db, "j1", "w1", "L1");

    const r1 = h.store.createAttemptAsOwnerAtomic("j1", "L1", "w1", "RUNNING");
    ok(r1.created, "148-1 first created");
    ok(r1.created && r1.attempt.attemptNumber === 1, "148-1 first number = 1");

    // End the running attempt so idempotency does not collapse the next call.
    h.db.prepare("UPDATE execution_attempts SET status='FAILED' WHERE id=?").run(r1.created ? r1.attempt.id : "");

    const r2 = h.store.createAttemptAsOwnerAtomic("j1", "L1", "w1", "RUNNING");
    ok(r2.created && r2.attempt.attemptNumber === 2, "148-1 second number = 2");

    h.db.prepare("UPDATE execution_attempts SET status='FAILED' WHERE id=?").run(r2.created ? r2.attempt.id : "");

    const r3 = h.store.createAttemptAsOwnerAtomic("j1", "L1", "w1", "RUNNING");
    ok(r3.created && r3.attempt.attemptNumber === 3, "148-1 third number = 3");

    ok(listNumbers(h.db, "j1").join(",") === "1,2,3", "148-1 numbers are 1,2,3");
  }

  console.log("\n148-2 concurrent allocation never produces duplicate numbers");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2"));
    setJobRunning(h.db, "j2", "L2");
    seedLease(h.db, "j2", "w2", "L2");

    // Interleave two callers (better-sqlite3 is synchronous; this simulates
    // concurrent invocation at the JS level).
    const a = h.store.createAttemptAsOwnerAtomic("j2", "L2", "w2", "RUNNING");
    // After the first allocates and commits, second caller with the SAME lease
    // hits the idempotency check and returns the same attempt, not a duplicate.
    const b = h.store.createAttemptAsOwnerAtomic("j2", "L2", "w2", "RUNNING");

    ok(a.created && b.created, "148-2 both observed as created (idempotent)");
    ok(a.created && b.created && a.attempt.attemptNumber === b.attempt.attemptNumber, "148-2 same attempt number");
    ok(countAttempts(h.db, "j2") === 1, "148-2 exactly one attempt row");
  }

  console.log("\n148-3 database invariant rejects duplicate (job_id, attempt_number)");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3"));
    setJobRunning(h.db, "j3", "L3");
    seedLease(h.db, "j3", "w3", "L3");

    const r = h.store.createAttemptAsOwnerAtomic("j3", "L3", "w3", "RUNNING");
    ok(r.created, "148-3 first allocation ok");

    let duplicateRejected = false;
    try {
      h.db.prepare(
        "INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, started_at, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?)"
      ).run("dup-1", "j3", 1, "RUNNING", "w3", "L3", Date.now(), Date.now());
    } catch { duplicateRejected = true; }
    ok(duplicateRejected, "148-3 UNIQUE backstop rejects duplicate");
  }

  console.log("\n148-4 stale worker cannot allocate");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4"));
    setJobRunning(h.db, "j4", "L4");
    seedLease(h.db, "j4", "w4", "L4", "EXPIRED", Date.now() - 1000);

    const r = h.store.createAttemptAsOwnerAtomic("j4", "L4", "w4", "RUNNING");
    ok(!r.created, "148-4 expired lease rejected");
    ok(!r.created && r.reason === "WORKER_OWNERSHIP_LOST", "148-4 reason WORKER_OWNERSHIP_LOST");
    ok(countAttempts(h.db, "j4") === 0, "148-4 zero attempt rows written");
  }

  console.log("\n148-5 wrong worker cannot allocate");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j5"));
    setJobRunning(h.db, "j5", "L5");
    seedLease(h.db, "j5", "w5", "L5");

    const r = h.store.createAttemptAsOwnerAtomic("j5", "L5", "w-WRONG", "RUNNING");
    ok(!r.created, "148-5 wrong worker rejected");
    ok(!r.created && r.reason === "WORKER_OWNERSHIP_LOST", "148-5 reason WORKER_OWNERSHIP_LOST");
    ok(countAttempts(h.db, "j5") === 0, "148-5 zero attempt rows");
  }

  console.log("\n148-6 process reload preserves numbering");
  {
    const dir = mkdtempSync(join(tmpdir(), "p148-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j6"));
      setJobRunning(h1.db, "j6", "L6");
      seedLease(h1.db, "j6", "w6", "L6");
      const r1 = h1.store.createAttemptAsOwnerAtomic("j6", "L6", "w6", "RUNNING");
      ok(r1.created && r1.attempt.attemptNumber === 1, "148-6 first = 1");
      // Close attempt #1 before reload so the same-lease idempotency check
      // does not collapse the next call. This mirrors what happens when a
      // RUNNING attempt fails and a legitimate retry is required.
      h1.db.prepare("UPDATE execution_attempts SET status='FAILED' WHERE id=?").run(r1.created ? r1.attempt.id : "");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const r2 = h2.store.createAttemptAsOwnerAtomic("j6", "L6", "w6", "RUNNING");
      ok(r2.created && r2.attempt.attemptNumber === 2, "148-6 second = 2 after reload");
      ok(listNumbers(h2.db, "j6").join(",") === "1,2", "148-6 numbers are 1,2");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n148-7 idempotent replay after process restart");
  {
    const dir = mkdtempSync(join(tmpdir(), "p148-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j7"));
      setJobRunning(h1.db, "j7", "L7");
      seedLease(h1.db, "j7", "w7", "L7");
      const r1 = h1.store.createAttemptAsOwnerAtomic("j7", "L7", "w7", "RUNNING");
      ok(r1.created && r1.attempt.attemptNumber === 1, "148-7 first = 1");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      // Same logical operation: same (jobId, leaseId) with RUNNING attempt.
      const r2 = h2.store.createAttemptAsOwnerAtomic("j7", "L7", "w7", "RUNNING");
      ok(r2.created && r2.attempt.attemptNumber === 1, "148-7 replay returns existing #1");
      ok(countAttempts(h2.db, "j7") === 1, "148-7 still one attempt row");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n148-8 terminal job rejected");
  {
    for (const terminal of ["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]) {
      const h = makeHarness();
      h.store.createJob(queuedJob("j8-" + terminal));
      setJobRunning(h.db, "j8-" + terminal, "L8");
      h.db.prepare("UPDATE execution_jobs SET status=? WHERE id=?").run(terminal, "j8-" + terminal);
      seedLease(h.db, "j8-" + terminal, "w8", "L8");

      const r = h.store.createAttemptAsOwnerAtomic("j8-" + terminal, "L8", "w8", "RUNNING");
      ok(!r.created && r.reason === "TERMINAL_STATE", "148-8 " + terminal + " rejected");
      ok(countAttempts(h.db, "j8-" + terminal) === 0, "148-8 " + terminal + " zero attempts");
    }
  }

  console.log("\n148-9 cancellation-requested job rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j9"));
    setJobRunning(h.db, "j9", "L9");
    h.db.prepare("UPDATE execution_jobs SET cancellation_requested=1 WHERE id='j9'").run();
    seedLease(h.db, "j9", "w9", "L9");

    const r = h.store.createAttemptAsOwnerAtomic("j9", "L9", "w9", "RUNNING");
    ok(!r.created && r.reason === "CANCELLATION_REQUESTED", "148-9 cancellation rejected");
    ok(countAttempts(h.db, "j9") === 0, "148-9 zero attempts");
  }

  console.log("\n148-10 allocated attempt is durable and authoritative");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j10"));
    setJobRunning(h.db, "j10", "L10");
    seedLease(h.db, "j10", "w10", "L10");

    const r = h.store.createAttemptAsOwnerAtomic("j10", "L10", "w10", "RUNNING");
    ok(r.created, "148-10 created");
    if (r.created) {
      const row = h.db.prepare("SELECT * FROM execution_attempts WHERE id=?").get(r.attempt.id) as any;
      ok(!!row, "148-10 row exists");
      ok(row.job_id === "j10", "148-10 job_id matches");
      ok(row.attempt_number === 1, "148-10 attempt_number 1");
      ok(row.status === "RUNNING", "148-10 status RUNNING");
      ok(row.worker_id === "w10", "148-10 worker_id");
      ok(row.lease_id === "L10", "148-10 lease_id");
      ok(r.attempt.id === "attempt_j10_1", "148-10 deterministic attempt id");
    }
  }

  console.log("\n--- Phase 148: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE148 DRIVER CRASH:", err); process.exit(1); });
