// scripts/test-phase150-job-attempt-terminal-consistency.ts
// Phase 150 - durable job/attempt terminal consistency.
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

function getJob(db: Database.Database, id: string) {
  return db.prepare("SELECT status, current_lease_id FROM execution_jobs WHERE id = ?").get(id) as any;
}
function getAttempt(db: Database.Database, id: string) {
  return db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id) as any;
}
function countEvents(db: Database.Database, jobId: string, type: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?").get(jobId, type) as any).n;
}
function countAttemptRows(db: Database.Database, jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get(jobId) as any).n;
}

async function main() {
  console.log("=== Phase 150 - Durable Job/Attempt Terminal Consistency ===\n");

  console.log("150-1 atomic SUCCESS: job+attempt both commit");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j1"));
    setJobRunning(h.db, "j1", "L1");
    seedLease(h.db, "j1", "w1", "L1");
    const c = h.store.createAttemptAsOwnerAtomic("j1", "L1", "w1", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j1", leaseId: "L1", workerId: "w1",
      attemptStatus: "SUCCEEDED", attemptEvidence: ["ok"],
      expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok && r.applied === true, "150-1 applied");
    ok(getJob(h.db, "j1").status === "SUCCEEDED", "150-1 job SUCCEEDED");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "150-1 attempt SUCCEEDED");
    ok(countEvents(h.db, "j1", "execution.transition.succeeded") === 1, "150-1 one transition event");
  }

  console.log("\n150-2 atomic FAILED: job+attempt both commit");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j2"));
    setJobRunning(h.db, "j2", "L2");
    seedLease(h.db, "j2", "w2", "L2");
    const c = h.store.createAttemptAsOwnerAtomic("j2", "L2", "w2", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j2", leaseId: "L2", workerId: "w2",
      attemptStatus: "FAILED", attemptError: "boom",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
      reason: "TEST_FAIL",
    });
    ok(r.ok && r.applied === true, "150-2 applied");
    ok(getJob(h.db, "j2").status === "FAILED", "150-2 job FAILED");
    ok(getAttempt(h.db, c.attempt.id).status === "FAILED", "150-2 attempt FAILED");
    ok(getAttempt(h.db, c.attempt.id).error === "boom", "150-2 attempt error durable");
  }

  console.log("\n150-3 idempotent replay of SUCCESS");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j3"));
    setJobRunning(h.db, "j3", "L3");
    seedLease(h.db, "j3", "w3", "L3");
    const c = h.store.createAttemptAsOwnerAtomic("j3", "L3", "w3", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const args = {
      attemptId: c.attempt.id, jobId: "j3", leaseId: "L3", workerId: "w3",
      attemptStatus: "SUCCEEDED" as const,
      expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    };
    h.store.completeAttemptAndTransitionJob(args);
    const r2 = h.store.completeAttemptAndTransitionJob(args);
    ok(r2.ok === true && r2.idempotent === true && r2.applied === false, "150-3 replay idempotent");
    ok(countEvents(h.db, "j3", "execution.transition.succeeded") === 1, "150-3 no duplicate event");
    ok(countAttemptRows(h.db, "j3") === 1, "150-3 one attempt row");
  }

  console.log("\n150-4 conflicting replay: SUCCESS then FAILED rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j4"));
    setJobRunning(h.db, "j4", "L4");
    seedLease(h.db, "j4", "w4", "L4");
    const c = h.store.createAttemptAsOwnerAtomic("j4", "L4", "w4", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j4", leaseId: "L4", workerId: "w4",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    const r2 = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j4", leaseId: "L4", workerId: "w4",
      attemptStatus: "FAILED", expectedJobStatus: "SUCCEEDED", newJobStatus: "FAILED",
      reason: "TEST_FAIL",
    });
    ok(r2.ok === false, "150-4 conflicting replay rejected");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "150-4 attempt stays SUCCEEDED");
    ok(getJob(h.db, "j4").status === "SUCCEEDED", "150-4 job stays SUCCEEDED");
  }

  console.log("\n150-5 stale worker rejected: nothing commits");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j5"));
    setJobRunning(h.db, "j5", "L5");
    seedLease(h.db, "j5", "w5", "L5");
    const c = h.store.createAttemptAsOwnerAtomic("j5", "L5", "w5", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L5'").run(Date.now() - 1000);

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j5", leaseId: "L5", workerId: "w5",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false && r.reason === "WORKER_OWNERSHIP_LOST", "150-5 stale rejected");
    ok(getJob(h.db, "j5").status === "RUNNING", "150-5 job unchanged");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "150-5 attempt unchanged");
    ok(countEvents(h.db, "j5", "execution.transition.succeeded") === 0, "150-5 no event written");
  }

  console.log("\n150-6 wrong worker rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j6"));
    setJobRunning(h.db, "j6", "L6");
    seedLease(h.db, "j6", "w6", "L6");
    const c = h.store.createAttemptAsOwnerAtomic("j6", "L6", "w6", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j6", leaseId: "L6", workerId: "w-WRONG",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false && r.reason === "WORKER_OWNERSHIP_LOST", "150-6 wrong worker rejected");
    ok(getJob(h.db, "j6").status === "RUNNING", "150-6 job unchanged");
  }

  console.log("\n150-7 wrong job_id rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j7"));
    h.store.createJob(queuedJob("j7-other"));
    setJobRunning(h.db, "j7", "L7");
    setJobRunning(h.db, "j7-other", "L7");
    seedLease(h.db, "j7", "w7", "L7");
    const c = h.store.createAttemptAsOwnerAtomic("j7", "L7", "w7", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j7-other", leaseId: "L7", workerId: "w7",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false, "150-7 wrong job_id rejected");
    ok(getJob(h.db, "j7").status === "RUNNING", "150-7 real job unchanged");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "150-7 attempt unchanged");
  }

  console.log("\n150-8 wrong attempt_id rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j8"));
    setJobRunning(h.db, "j8", "L8");
    seedLease(h.db, "j8", "w8", "L8");
    const c = h.store.createAttemptAsOwnerAtomic("j8", "L8", "w8", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: "nonexistent-attempt", jobId: "j8", leaseId: "L8", workerId: "w8",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false && r.reason === "ATTEMPT_NOT_FOUND", "150-8 bad attempt rejected");
    ok(getJob(h.db, "j8").status === "RUNNING", "150-8 job unchanged");
  }

  console.log("\n150-9 wrong expected job status rejects, nothing commits");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j9"));
    setJobRunning(h.db, "j9", "L9");
    seedLease(h.db, "j9", "w9", "L9");
    const c = h.store.createAttemptAsOwnerAtomic("j9", "L9", "w9", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j9", leaseId: "L9", workerId: "w9",
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "VERIFYING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false, "150-9 wrong expected status rejected");
    ok(getJob(h.db, "j9").status === "RUNNING", "150-9 job unchanged");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "150-9 attempt rolled back");
    ok(countEvents(h.db, "j9", "execution.transition.succeeded") === 0, "150-9 no event");
  }

  console.log("\n150-10 terminal attempt cannot be overwritten via combined primitive");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j10"));
    setJobRunning(h.db, "j10", "L10");
    seedLease(h.db, "j10", "w10", "L10");
    const c = h.store.createAttemptAsOwnerAtomic("j10", "L10", "w10", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED' WHERE id=?").run(c.attempt.id);

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j10", leaseId: "L10", workerId: "w10",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    ok(r.ok === false && r.reason === "ATTEMPT_STATE_MISMATCH", "150-10 terminal conflict");
    ok(getAttempt(h.db, c.attempt.id).status === "FAILED", "150-10 attempt stays FAILED");
    ok(getJob(h.db, "j10").status === "RUNNING", "150-10 job unchanged");
  }

  console.log("\n150-11 cross-attempt: older attempt id does not touch newer attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j11"));
    setJobRunning(h.db, "j11", "L11");
    seedLease(h.db, "j11", "w11", "L11");
    const c1 = h.store.createAttemptAsOwnerAtomic("j11", "L11", "w11", "RUNNING");
    if (!c1.created) throw new Error("alloc 1");
    h.store.updateAttemptAsOwner(
      { ...c1.attempt, status: "FAILED" as any, error: "first-fail", completedAt: Date.now() },
      "L11", "w11"
    );
    const c2 = h.store.createAttemptAsOwnerAtomic("j11", "L11", "w11", "RUNNING");
    if (!c2.created) throw new Error("alloc 2");

    // Try to terminalize #2 but pass #1's id — the primitive must refuse.
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c1.attempt.id, jobId: "j11", leaseId: "L11", workerId: "w11",
      attemptStatus: "FAILED", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
      reason: "TEST_FAIL",
    });
    ok(r.ok === false, "150-11 cross-attempt rejected");
    ok(getAttempt(h.db, c2.attempt.id).status === "RUNNING", "150-11 newer attempt untouched");
  }

  console.log("\n150-12 durable across reload");
  {
    const dir = mkdtempSync(join(tmpdir(), "p150-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j12"));
      setJobRunning(h1.db, "j12", "L12");
      seedLease(h1.db, "j12", "w12", "L12");
      const c = h1.store.createAttemptAsOwnerAtomic("j12", "L12", "w12", "RUNNING");
      if (!c.created) throw new Error("alloc failed");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: c.attempt.id, jobId: "j12", leaseId: "L12", workerId: "w12",
        attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
        reason: "TEST_SUCCESS",
      });
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getJob(h2.db, "j12").status === "SUCCEEDED", "150-12 job durable");
      ok(getAttempt(h2.db, c.attempt.id).status === "SUCCEEDED", "150-12 attempt durable");
      ok(countEvents(h2.db, "j12", "execution.transition.succeeded") === 1, "150-12 event durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n150-13 pre-committed attempt RUNNING with terminal job cannot be revived");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j13"));
    setJobRunning(h.db, "j13", "L13");
    seedLease(h.db, "j13", "w13", "L13");
    const c = h.store.createAttemptAsOwnerAtomic("j13", "L13", "w13", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    // Simulate crash-after-job-transition: job manually set terminal but attempt still RUNNING.
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='j13'").run();

    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j13", leaseId: "L13", workerId: "w13",
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    // Job is already SUCCEEDED, attempt is RUNNING. Expected status mismatch → reject, no partial.
    ok(r.ok === false, "150-13 stale expected status rejected");
    ok(getJob(h.db, "j13").status === "SUCCEEDED", "150-13 job still SUCCEEDED");
    ok(getAttempt(h.db, c.attempt.id).status === "RUNNING", "150-13 attempt untouched");
  }

  console.log("\n150-14 no duplicate event on idempotent replay");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j14"));
    setJobRunning(h.db, "j14", "L14");
    seedLease(h.db, "j14", "w14", "L14");
    const c = h.store.createAttemptAsOwnerAtomic("j14", "L14", "w14", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const args = {
      attemptId: c.attempt.id, jobId: "j14", leaseId: "L14", workerId: "w14",
      attemptStatus: "FAILED" as const, attemptError: "err",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
      reason: "TEST_FAIL",
    };
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    ok(countEvents(h.db, "j14", "execution.transition.failed") === 1, "150-14 one event");
    ok(countAttemptRows(h.db, "j14") === 1, "150-14 one attempt row");
  }

  console.log("\n150-15 concurrent SUCCESS/SUCCESS converge to one event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j15"));
    setJobRunning(h.db, "j15", "L15");
    seedLease(h.db, "j15", "w15", "L15");
    const c = h.store.createAttemptAsOwnerAtomic("j15", "L15", "w15", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const args = {
      attemptId: c.attempt.id, jobId: "j15", leaseId: "L15", workerId: "w15",
      attemptStatus: "SUCCEEDED" as const,
      expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    };
    const a = h.store.completeAttemptAndTransitionJob(args);
    const b = h.store.completeAttemptAndTransitionJob(args);
    const applied = (a.applied ? 1 : 0) + (b.applied ? 1 : 0);
    const idem = (a.idempotent ? 1 : 0) + (b.idempotent ? 1 : 0);
    ok(applied === 1, "150-15 exactly one applied");
    ok(idem === 1, "150-15 exactly one idempotent");
    ok(countEvents(h.db, "j15", "execution.transition.succeeded") === 1, "150-15 one event");
  }

  console.log("\n150-16 Phase 148 atomic allocation still works");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j16"));
    setJobRunning(h.db, "j16", "L16");
    seedLease(h.db, "j16", "w16", "L16");
    const c1 = h.store.createAttemptAsOwnerAtomic("j16", "L16", "w16", "RUNNING");
    ok(c1.created && c1.attempt.attemptNumber === 1, "150-16 alloc #1");
    const dup = h.store.createAttemptAsOwnerAtomic("j16", "L16", "w16", "RUNNING");
    ok(dup.created && dup.attempt.id === c1.attempt.id, "150-16 idempotent same-lease");
  }

  console.log("\n150-17 Phase 149 terminalization still works standalone");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j17"));
    setJobRunning(h.db, "j17", "L17");
    seedLease(h.db, "j17", "w17", "L17");
    const c = h.store.createAttemptAsOwnerAtomic("j17", "L17", "w17", "RUNNING");
    if (!c.created) throw new Error("alloc failed");
    const r = h.store.updateAttemptAsOwner(
      { ...c.attempt, status: "SUCCEEDED" as any, completedAt: Date.now() },
      "L17", "w17"
    );
    ok(r.updated === true && r.applied === true, "150-17 applied");
    const r2 = h.store.updateAttemptAsOwner(
      { ...c.attempt, status: "SUCCEEDED" as any, completedAt: Date.now() },
      "L17", "w17"
    );
    ok(r2.updated === true && r2.applied === false, "150-17 idempotent replay");
  }

  console.log("\n150-18 terminal job cannot be reached via two contradictory combined calls");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("j18"));
    setJobRunning(h.db, "j18", "L18");
    seedLease(h.db, "j18", "w18", "L18");
    const c = h.store.createAttemptAsOwnerAtomic("j18", "L18", "w18", "RUNNING");
    if (!c.created) throw new Error("alloc failed");

    const success = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j18", leaseId: "L18", workerId: "w18",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      reason: "TEST_SUCCESS",
    });
    const failure = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "j18", leaseId: "L18", workerId: "w18",
      attemptStatus: "FAILED", attemptError: "late",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
      reason: "TEST_FAIL",
    });
    ok(success.ok === true && success.applied === true, "150-18 success applied");
    ok(failure.ok === false, "150-18 late failure rejected");
    ok(getJob(h.db, "j18").status === "SUCCEEDED", "150-18 job stays SUCCEEDED");
    ok(getAttempt(h.db, c.attempt.id).status === "SUCCEEDED", "150-18 attempt stays SUCCEEDED");
    ok(countEvents(h.db, "j18", "execution.transition.succeeded") === 1, "150-18 one success event");
    ok(countEvents(h.db, "j18", "execution.transition.failed") === 0, "150-18 no failed event");
  }

  console.log("\n--- Phase 150: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE150 DRIVER CRASH:", err); process.exit(1); });
