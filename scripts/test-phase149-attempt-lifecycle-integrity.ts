// scripts/test-phase149-attempt-lifecycle-integrity.ts
// Phase 149 - durable attempt lifecycle & terminalization integrity.
//
// Every assertion reads durable SQLite rows. No mocks of the persistence layer.

import Database from "better-sqlite3";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionJob, ExecutionAttempt } from "../src/core/execution-models";

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

function getAttempt(db: Database.Database, id: string) {
  return db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id) as any;
}
function countAttemptRows(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get(jobId) as any).n;
}

function mkAttempt(jobId: string, id: string, status: string): ExecutionAttempt {
  return {
    id, jobId, attemptNumber: 1, status: status as any,
    workerId: "w1", leaseId: "L1",
    startedAt: Date.now() - 1000, completedAt: Date.now(), createdAt: Date.now() - 2000,
  } as ExecutionAttempt;
}

async function main() {
  console.log("=== Phase 149 - Durable Attempt Lifecycle & Terminalization Integrity ===\n");

  console.log("149-1 RUNNING -> SUCCEEDED applied");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1"));
    setJobRunning(h.db, "j1", "L1");
    seedLease(h.db, "j1", "w1", "L1");
    const c = h.store.createAttemptAsOwnerAtomic("j1", "L1", "w1", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j1", c.attempt.id, "SUCCEEDED"), "L1", "w1");
    ok(r.updated === true && r.applied === true, "149-1 applied true");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "149-1 durable SUCCEEDED");
  }

  console.log("\n149-2 RUNNING -> FAILED applied");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2"));
    setJobRunning(h.db, "j2", "L2");
    seedLease(h.db, "j2", "w2", "L2");
    const c = h.store.createAttemptAsOwnerAtomic("j2", "L2", "w2", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j2", c.attempt.id, "FAILED"), "L2", "w2");
    ok(r.updated === true && r.applied === true, "149-2 applied true");
    ok(getAttempt(h.db, c.attempt.id).status === "FAILED", "149-2 durable FAILED");
  }

  console.log("\n149-3 duplicate SUCCESS is idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3"));
    setJobRunning(h.db, "j3", "L3");
    seedLease(h.db, "j3", "w3", "L3");
    const c = h.store.createAttemptAsOwnerAtomic("j3", "L3", "w3", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j3", c.attempt.id, "SUCCEEDED"), "L3", "w3");
    const replay = h.store.updateAttemptAsOwner(mkAttempt("j3", c.attempt.id, "SUCCEEDED"), "L3", "w3");
    ok(replay.updated === true && replay.applied === false, "149-3 replay idempotent");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "149-3 status unchanged");
  }

  console.log("\n149-4 duplicate FAILURE is idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4"));
    setJobRunning(h.db, "j4", "L4");
    seedLease(h.db, "j4", "w4", "L4");
    const c = h.store.createAttemptAsOwnerAtomic("j4", "L4", "w4", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j4", c.attempt.id, "FAILED"), "L4", "w4");
    const replay = h.store.updateAttemptAsOwner(mkAttempt("j4", c.attempt.id, "FAILED"), "L4", "w4");
    ok(replay.updated === true && replay.applied === false, "149-4 replay idempotent");
    ok(getAttempt(h.db, c.attempt.id).status === "FAILED", "149-4 status unchanged");
  }

  console.log("\n149-5 SUCCEEDED -> FAILED rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j5"));
    setJobRunning(h.db, "j5", "L5");
    seedLease(h.db, "j5", "w5", "L5");
    const c = h.store.createAttemptAsOwnerAtomic("j5", "L5", "w5", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j5", c.attempt.id, "SUCCEEDED"), "L5", "w5");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j5", c.attempt.id, "FAILED"), "L5", "w5");
    ok(r.updated === false && r.reason === "TERMINAL_STATE_CONFLICT", "149-5 rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "149-5 status unchanged");
  }

  console.log("\n149-6 FAILED -> SUCCEEDED rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j6"));
    setJobRunning(h.db, "j6", "L6");
    seedLease(h.db, "j6", "w6", "L6");
    const c = h.store.createAttemptAsOwnerAtomic("j6", "L6", "w6", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j6", c.attempt.id, "FAILED"), "L6", "w6");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j6", c.attempt.id, "SUCCEEDED"), "L6", "w6");
    ok(r.updated === false && r.reason === "TERMINAL_STATE_CONFLICT", "149-6 rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "FAILED", "149-6 status unchanged");
  }

  console.log("\n149-7 terminal -> RUNNING rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j7"));
    setJobRunning(h.db, "j7", "L7");
    seedLease(h.db, "j7", "w7", "L7");
    const c = h.store.createAttemptAsOwnerAtomic("j7", "L7", "w7", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j7", c.attempt.id, "SUCCEEDED"), "L7", "w7");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j7", c.attempt.id, "RUNNING"), "L7", "w7");
    ok(r.updated === false && r.reason === "TERMINAL_STATE_CONFLICT", "149-7 resurrection rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "149-7 unchanged");
  }

  console.log("\n149-8 stale worker cannot complete attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j8"));
    setJobRunning(h.db, "j8", "L8");
    seedLease(h.db, "j8", "w8", "L8", "EXPIRED", Date.now() - 1000);
    // Allocate with a valid lease first; then expire it and try to terminalize.
    h.db.prepare("UPDATE execution_leases SET status='ACTIVE', expires_at=? WHERE lease_id='L8'").run(Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("j8", "L8", "w8", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L8'").run(Date.now() - 1000);
    const r = h.store.updateAttemptAsOwner(mkAttempt("j8", c.attempt.id, "SUCCEEDED"), "L8", "w8");
    ok(r.updated === false && r.reason === "WORKER_OWNERSHIP_LOST", "149-8 rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "149-8 unchanged");
  }

  console.log("\n149-9 stale worker cannot fail attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j9"));
    setJobRunning(h.db, "j9", "L9");
    seedLease(h.db, "j9", "w9", "L9");
    const c = h.store.createAttemptAsOwnerAtomic("j9", "L9", "w9", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L9'").run(Date.now() - 1000);
    const r = h.store.updateAttemptAsOwner(mkAttempt("j9", c.attempt.id, "FAILED"), "L9", "w9");
    ok(r.updated === false && r.reason === "WORKER_OWNERSHIP_LOST", "149-9 rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "149-9 unchanged");
  }

  console.log("\n149-10 wrong worker cannot terminalize");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j10"));
    setJobRunning(h.db, "j10", "L10");
    seedLease(h.db, "j10", "w10", "L10");
    const c = h.store.createAttemptAsOwnerAtomic("j10", "L10", "w10", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j10", c.attempt.id, "SUCCEEDED"), "L10", "w-WRONG");
    ok(r.updated === false && r.reason === "WORKER_OWNERSHIP_LOST", "149-10 wrong worker rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "149-10 unchanged");
  }

  console.log("\n149-11 expired lease cannot terminalize");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j11"));
    setJobRunning(h.db, "j11", "L11");
    seedLease(h.db, "j11", "w11", "L11");
    const c = h.store.createAttemptAsOwnerAtomic("j11", "L11", "w11", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const r = h.store.updateAttemptAsOwner(mkAttempt("j11", c.attempt.id, "SUCCEEDED"), "L11", "w11", Date.now() + 120000);
    // Pass a future `now` so expires_at (60s away) is in the past relative to the fence.
    ok(r.updated === false && r.reason === "WORKER_OWNERSHIP_LOST", "149-11 expired lease rejected");
  }

  console.log("\n149-12 attempt ID prevents cross-attempt mutation");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j12"));
    setJobRunning(h.db, "j12", "L12");
    seedLease(h.db, "j12", "w12", "L12");
    const c1 = h.store.createAttemptAsOwnerAtomic("j12", "L12", "w12", "RUNNING");
    if (!c1.created) throw new Error("alloc failed 1");
    // Terminalize #1 to make room for #2.
    h.store.updateAttemptAsOwner(mkAttempt("j12", c1.attempt.id, "FAILED"), "L12", "w12");
    const c2 = h.store.createAttemptAsOwnerAtomic("j12", "L12", "w12", "RUNNING");
    if (!c2.created) throw new Error("alloc failed 2");
    // Try to terminalize #2 by id but with #1's id in the id field. Should hit ATTEMPT_NOT_FOUND for attempt #2's row via id mismatch.
    const bad = mkAttempt("j12", c1.attempt.id, "SUCCEEDED");
    const r = h.store.updateAttemptAsOwner(bad, "L12", "w12");
    // #1 is already FAILED, target SUCCEEDED → conflict; either way #2 must remain RUNNING.
    ok(getAttempt(h.db, c2.attempt.id).status === "RUNNING", "149-12 attempt #2 unchanged");
    ok(getAttempt(h.db, c1.attempt.id).status === "FAILED", "149-12 attempt #1 unchanged");
  }

  console.log("\n149-13 two concurrent SUCCESS calls converge to one terminal state");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j13"));
    setJobRunning(h.db, "j13", "L13");
    seedLease(h.db, "j13", "w13", "L13");
    const c = h.store.createAttemptAsOwnerAtomic("j13", "L13", "w13", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const a = h.store.updateAttemptAsOwner(mkAttempt("j13", c.attempt.id, "SUCCEEDED"), "L13", "w13");
    const b = h.store.updateAttemptAsOwner(mkAttempt("j13", c.attempt.id, "SUCCEEDED"), "L13", "w13");
    const appliedCount = (a.applied ? 1 : 0) + (b.applied ? 1 : 0);
    ok(appliedCount === 1, "149-13 exactly one applied");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "149-13 one terminal state");
  }

  console.log("\n149-14 concurrent SUCCESS vs FAILURE has exactly one authoritative result");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j14"));
    setJobRunning(h.db, "j14", "L14");
    seedLease(h.db, "j14", "w14", "L14");
    const c = h.store.createAttemptAsOwnerAtomic("j14", "L14", "w14", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const a = h.store.updateAttemptAsOwner(mkAttempt("j14", c.attempt.id, "SUCCEEDED"), "L14", "w14");
    const b = h.store.updateAttemptAsOwner(mkAttempt("j14", c.attempt.id, "FAILED"), "L14", "w14");
    const appliedCount = (a.applied ? 1 : 0) + (b.applied ? 1 : 0);
    const conflictCount = (a.reason === "TERMINAL_STATE_CONFLICT" ? 1 : 0) + (b.reason === "TERMINAL_STATE_CONFLICT" ? 1 : 0);
    ok(appliedCount === 1, "149-14 exactly one applied");
    ok(conflictCount === 1, "149-14 other is TERMINAL_STATE_CONFLICT");
    const final = getAttempt(h.db, c.attempt.id).status;
    ok(final === "SUCCEEDED" || final === "FAILED", "149-14 one terminal state");
  }

  console.log("\n149-15 terminal attempt survives process reload");
  {
    const dir = mkdtempSync(join(tmpdir(), "p149-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j15"));
      setJobRunning(h1.db, "j15", "L15");
      seedLease(h1.db, "j15", "w15", "L15");
      const c = h1.store.createAttemptAsOwnerAtomic("j15", "L15", "w15", "RUNNING");
      if (!c.created) throw new Error("alloc failed");
      h1.store.updateAttemptAsOwner(mkAttempt("j15", c.attempt.id, "SUCCEEDED"), "L15", "w15");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getAttempt(h2.db, c.attempt.id).status === "SUCCEEDED", "149-15 terminal durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n149-16 RUNNING attempt survives reload and remains recoverable");
  {
    const dir = mkdtempSync(join(tmpdir(), "p149-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j16"));
      setJobRunning(h1.db, "j16", "L16");
      seedLease(h1.db, "j16", "w16", "L16");
      const c = h1.store.createAttemptAsOwnerAtomic("j16", "L16", "w16", "RUNNING");
      if (!c.created) throw new Error("alloc failed");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getAttempt(h2.db, c.attempt.id).status === "RUNNING", "149-16 still RUNNING");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n149-17 terminalization does not create duplicate attempt rows");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j17"));
    setJobRunning(h.db, "j17", "L17");
    seedLease(h.db, "j17", "w17", "L17");
    const c = h.store.createAttemptAsOwnerAtomic("j17", "L17", "w17", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.store.updateAttemptAsOwner(mkAttempt("j17", c.attempt.id, "SUCCEEDED"), "L17", "w17");
    h.store.updateAttemptAsOwner(mkAttempt("j17", c.attempt.id, "SUCCEEDED"), "L17", "w17");
    ok(countAttemptRows(h.db, "j17") === 1, "149-17 one attempt row");
  }

  console.log("\n149-18 new attempt cannot be mutated through older attempt ID");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j18"));
    setJobRunning(h.db, "j18", "L18");
    seedLease(h.db, "j18", "w18", "L18");
    const c1 = h.store.createAttemptAsOwnerAtomic("j18", "L18", "w18", "RUNNING");
    if (!c1.created) throw new Error("alloc 1");
    h.store.updateAttemptAsOwner(mkAttempt("j18", c1.attempt.id, "FAILED"), "L18", "w18");
    const c2 = h.store.createAttemptAsOwnerAtomic("j18", "L18", "w18", "RUNNING");
    if (!c2.created) throw new Error("alloc 2");
    // Attempt to succeed #2 via #1's id (already FAILED). Must not touch #2.
    h.store.updateAttemptAsOwner(mkAttempt("j18", c1.attempt.id, "SUCCEEDED"), "L18", "w18");
    ok(getAttempt(h.db, c2.attempt.id).status === "RUNNING", "149-18 #2 untouched");
  }

  console.log("\n149-19 parent job remains consistent with attempt terminalization");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j19"));
    setJobRunning(h.db, "j19", "L19");
    seedLease(h.db, "j19", "w19", "L19");
    const c = h.store.createAttemptAsOwnerAtomic("j19", "L19", "w19", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.store.updateAttemptAsOwner(mkAttempt("j19", c.attempt.id, "SUCCEEDED"), "L19", "w19");
    const attempt = getAttempt(h.db, c.attempt.id);
    const job = h.db.prepare("SELECT status FROM execution_jobs WHERE id = ?").get("j19") as any;
    ok(attempt.status === "SUCCEEDED", "149-19 attempt SUCCEEDED");
    // Job is still RUNNING because Phase 149 does not modify the job — that's the engine's job.
    ok(job.status === "RUNNING", "149-19 job untouched by attempt terminalization (engine-owned transition)");
  }

  console.log("\n149-20 Phase 148 atomic allocation regression");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j20"));
    setJobRunning(h.db, "j20", "L20");
    seedLease(h.db, "j20", "w20", "L20");
    const a = h.store.createAttemptAsOwnerAtomic("j20", "L20", "w20", "RUNNING");
    ok(a.created && a.attempt.attemptNumber === 1, "149-20 alloc 1");
    const dup = h.store.createAttemptAsOwnerAtomic("j20", "L20", "w20", "RUNNING");
    ok(dup.created && dup.attempt.id === a.attempt.id, "149-20 idempotent same-lease");
    ok(countAttemptRows(h.db, "j20") === 1, "149-20 one row");
  }

  console.log("\n--- Phase 149: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE149 DRIVER CRASH:", err); process.exit(1); });
