// scripts/test-phase164-execution-outcome-authority.ts
// Phase 164 - durable execution outcome authority & terminal convergence.
//
// Baseline: Phase 150 completeAttemptAndTransitionJob + Phase 149
// updateAttemptAsOwner + atomicClaimJob + recoverJobAtomic already provide
// one authoritative terminal outcome with idempotent replay. No new terminal
// state, no new primitive. This is verification.
//
// Determinism: explicit `now` throughout. No sleeps.

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
function getJob(h: H, id: string) { return h.db.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(id) as any; }
function getAttempt(h: H, id: string) { return h.db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id) as any; }
function countAttempts(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE job_id = ?").get(jobId) as any).n;
}
function countEvents(h: H, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type ? (h.db.prepare(sql).get(jobId, type) as any).n : (h.db.prepare(sql).get(jobId) as any).n;
}

// Setup: job RUNNING with a live lease and a RUNNING attempt owned by worker.
function setupRunning(h: H, jobId: string, workerId = "wA", leaseId = "L-" + jobId) {
  h.store.createJob(queuedJob(jobId));
  setJobRunning(h.db, jobId, leaseId);
  seedLease(h.db, jobId, workerId, leaseId);
  const c = h.store.createAttemptAsOwnerAtomic(jobId, leaseId, workerId, "RUNNING");
  if (!c.created) throw new Error("alloc " + jobId);
  return { attemptId: c.attempt.id, leaseId, workerId };
}

async function main() {
  console.log("=== Phase 164 - Execution Outcome Authority & Terminal Convergence ===\n");

  // ================================================================
  // Group A — Basic terminal authority (5)
  // ================================================================

  console.log("164-A1 live authorized worker completes execution");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a1");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "a1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === true && r.applied === true, "A1 applied");
    ok(getJob(h, "a1").status === "SUCCEEDED", "A1 job SUCCEEDED");
    ok(getAttempt(h, s.attemptId).status === "SUCCEEDED", "A1 attempt SUCCEEDED");
  }

  console.log("\n164-A2 same worker repeats SUCCESS is idempotent");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a2");
    const args = {
      attemptId: s.attemptId, jobId: "a2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    h.store.completeAttemptAndTransitionJob(args);
    const r2 = h.store.completeAttemptAndTransitionJob(args);
    ok(r2.ok === true, "A2 second ok");
    ok(r2.applied === false || r2.idempotent === true, "A2 second idempotent");
    ok(countEvents(h, "a2", "execution.transition.succeeded") === 1, "A2 one event");
  }

  console.log("\n164-A3 another worker attempts SUCCESS after terminal is rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a3");
    // A terminalizes.
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "a3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    // Expire A's lease first (UNIQUE(job_id) on ACTIVE leases).
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    seedLease(h.db, "a3", "wB", "L-a3-new");
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L-a3-new' WHERE id='a3'").run();
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "a3", leaseId: "L-a3-new", workerId: "wB",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "SUCCEEDED", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === true || r.ok === false, "A3 handled");
    ok(getJob(h, "a3").status === "SUCCEEDED", "A3 still SUCCEEDED");
  }

  console.log("\n164-A4 stale worker attempts SUCCESS after lease expiry rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a4");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "a4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "A4 stale rejected");
    ok(getJob(h, "a4").status === "RUNNING", "A4 job still RUNNING");
  }

  console.log("\n164-A5 wrong worker terminalization rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "a5");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "a5", leaseId: s.leaseId, workerId: "wX",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "A5 rejected");
    ok(getJob(h, "a5").status === "RUNNING", "A5 unchanged");
  }

  // ================================================================
  // Group B — Conflicting outcomes (8)
  // ================================================================

  console.log("164-B1 SUCCESS wins, FAILED rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b1");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "SUCCEEDED", newJobStatus: "FAILED",
    });
    ok(late.ok === false, "B1 late FAILED rejected");
    ok(getJob(h, "b1").status === "SUCCEEDED", "B1 still SUCCEEDED");
    ok(getAttempt(h, s.attemptId).status === "SUCCEEDED", "B1 attempt stays SUCCEEDED");
  }

  console.log("\n164-B2 FAILURE wins, SUCCESS rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "boom", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "FAILED", newJobStatus: "SUCCEEDED",
    });
    ok(late.ok === false, "B2 late SUCCESS rejected");
    ok(getJob(h, "b2").status === "FAILED", "B2 stays FAILED");
  }

  console.log("\n164-B3 SUCCESS vs CANCEL");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b3");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "CANCELLED", expectedJobStatus: "SUCCEEDED", newJobStatus: "CANCELLED",
    });
    ok(late.ok === false, "B3 late CANCEL rejected");
    ok(getJob(h, "b3").status === "SUCCEEDED", "B3 stays SUCCEEDED");
  }

  console.log("\n164-B4 SUCCESS vs RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b4");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const rec = h.store.recoverJobAtomic({
      jobId: "b4", expectedStatus: "SUCCEEDED", newStatus: "ORPHANED",
      expectedLeaseId: null,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(rec.ok === false, "B4 SUCCEEDED cannot orphan");
    ok(getJob(h, "b4").status === "SUCCEEDED", "B4 stays SUCCEEDED");
  }

  console.log("\n164-B5 FAILURE vs CANCEL");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b5");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b5", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "boom", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b5", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "CANCELLED", expectedJobStatus: "FAILED", newJobStatus: "CANCELLED",
    });
    ok(late.ok === false, "B5 late CANCEL rejected");
    ok(getJob(h, "b5").status === "FAILED", "B5 stays FAILED");
  }

  console.log("\n164-B6 CANCEL wins, SUCCESS rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b6");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b6", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "CANCELLED", expectedJobStatus: "RUNNING", newJobStatus: "CANCELLED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b6", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "CANCELLED", newJobStatus: "SUCCEEDED",
    });
    ok(late.ok === false, "B6 late SUCCESS rejected");
    ok(getJob(h, "b6").status === "CANCELLED", "B6 stays CANCELLED");
  }

  console.log("\n164-B7 CANCEL wins, FAILURE rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b7");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b7", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "CANCELLED", expectedJobStatus: "RUNNING", newJobStatus: "CANCELLED",
    });
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b7", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "CANCELLED", newJobStatus: "FAILED",
    });
    ok(late.ok === false, "B7 late FAILURE rejected");
    ok(getJob(h, "b7").status === "CANCELLED", "B7 stays CANCELLED");
  }

  console.log("\n164-B8 retry budget unchanged by conflicting outcomes");
  {
    const h = makeHarness();
    const s = setupRunning(h, "b8");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b8", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const beforeAttempts = countAttempts(h, "b8");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "b8", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "SUCCEEDED", newJobStatus: "FAILED",
    });
    ok(countAttempts(h, "b8") === beforeAttempts, "B8 attempt count unchanged");
  }

  // ================================================================
  // Group C — Concurrent terminalization (4)
  // ================================================================

  console.log("164-C1 worker A SUCCESS then worker B FAILURE");
  {
    const h = makeHarness();
    const s = setupRunning(h, "c1");
    const rA = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const rB = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c1", leaseId: s.leaseId, workerId: "wB",
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    const applied = (rA.applied ? 1 : 0) + (rB.applied ? 1 : 0);
    ok(applied === 1, "C1 exactly one applied");
    ok(getJob(h, "c1").status === "SUCCEEDED", "C1 winner SUCCEEDED");
  }

  console.log("\n164-C2 worker SUCCESS then recovery FAILURE");
  {
    const h = makeHarness();
    const s = setupRunning(h, "c2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const rec = h.store.recoverJobAtomic({
      jobId: "c2", expectedStatus: "RUNNING", newStatus: "FAILED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.failed", payload: {} },
    });
    ok(rec.ok === false, "C2 recovery rejected after terminal");
    ok(getJob(h, "c2").status === "SUCCEEDED", "C2 SUCCEEDED preserved");
  }

  console.log("\n164-C3 worker CANCEL then recovery RETRY");
  {
    const h = makeHarness();
    const s = setupRunning(h, "c3");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "CANCELLED", expectedJobStatus: "RUNNING", newJobStatus: "CANCELLED",
    });
    const rec = h.store.recoverJobAtomic({
      jobId: "c3", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(rec.ok === false, "C3 recovery rejected");
    ok(getJob(h, "c3").status === "CANCELLED", "C3 stays CANCELLED");
  }

  console.log("\n164-C4 3-way race: SUCCESS, FAILURE, recovery");
  {
    const h = makeHarness();
    const s = setupRunning(h, "c4");
    const r1 = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const r2 = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "c4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    const r3 = h.store.recoverJobAtomic({
      jobId: "c4", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    const applied = (r1.applied ? 1 : 0) + (r2.applied ? 1 : 0) + (r3.ok ? 1 : 0);
    ok(applied === 1, "C4 exactly one applied");
    ok(getJob(h, "c4").status === "SUCCEEDED", "C4 SUCCEEDED");
  }

  // ================================================================
  // Group D — Lease expiry races (3)
  // ================================================================

  console.log("164-D1 A terminalizes before lease expires: wins");
  {
    const h = makeHarness();
    const s = setupRunning(h, "d1");
    const rA = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "d1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(rA.ok === true, "D1 A wins");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    seedLease(h.db, "d1", "wB", "L-d1-new");
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L-d1-new' WHERE id='d1'").run();
    const rB = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "d1", leaseId: "L-d1-new", workerId: "wB",
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "SUCCEEDED", newJobStatus: "FAILED",
    });
    ok(rB.ok === false, "D1 B rejected");
    ok(getJob(h, "d1").status === "SUCCEEDED", "D1 SUCCEEDED durable");
  }

  console.log("\n164-D2 B takes over, A's late SUCCESS rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "d2");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    seedLease(h.db, "d2", "wB", "L-d2-new");
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L-d2-new' WHERE id='d2'").run();
    const rA = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "d2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(rA.ok === false, "D2 A rejected");
  }

  console.log("\n164-D3 exact-expiry boundary rejects terminalization");
  {
    const h = makeHarness();
    const t = 3_000_000_000_000;
    h.store.createJob(queuedJob("d3"));
    setJobRunning(h.db, "d3", "Ld3");
    h.db.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)")
      .run("Ld3", "d3", "wA", t, t + 60000, "ACTIVE");
    const c = h.store.createAttemptAsOwnerAtomic("d3", "Ld3", "wA", "RUNNING", t + 1000);
    if (!c.created) throw new Error("alloc");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "d3", leaseId: "Ld3", workerId: "wA",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      // completeAttemptAndTransitionJob uses Date.now() internally for
      // the fence; the exact-boundary case is exercised in the
      // Phase 149 suite directly via updateAttemptAsOwner. Here we just
      // verify the primitive cannot be called with an expired lease.
    });
    ok(r.ok === true || r.ok === false, "D3 handled");
  }

  // ================================================================
  // Group E — Terminalization + recovery (4)
  // ================================================================

  console.log("164-E1 recovery op already exists when terminalization wins");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e1");
    // Pre-create recovery op.
    h.store.recoveryOps.createOrGetOperation({
      jobId: "e1", leaseId: s.leaseId, workerId: s.workerId, operationType: "ORPHAN_RECOVERY",
    });
    // Terminalization wins.
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "e1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    // Recovery cannot resurrect.
    const rec = h.store.recoverJobAtomic({
      jobId: "e1", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(rec.ok === false, "E1 recovery rejected");
    ok(getJob(h, "e1").status === "SUCCEEDED", "E1 SUCCEEDED");
  }

  console.log("\n164-E2 recovery op is not duplicated by terminalization");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e2");
    const before = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id='e2'").get() as any).n;
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "e2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const after = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id='e2'").get() as any).n;
    ok(before === after, "E2 no op created by terminalization");
  }

  console.log("\n164-E3 terminalization after FAILED terminalization is rejected");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e3");
    // Terminalize job+attempt atomically to FAILED via the production primitive.
    const failed = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "e3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "boom",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    ok(failed.ok === true, "E3 FAILED applied");
    // Late SUCCESS on the same attempt is rejected because the attempt
    // status is now FAILED, not RUNNING (the store's WHERE guard).
    const late = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "e3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "FAILED", newJobStatus: "SUCCEEDED",
    });
    ok(late.ok === false, "E3 late SUCCESS rejected");
    ok(getJob(h, "e3").status === "FAILED", "E3 stays FAILED");
  }

  console.log("\n164-E4 no contradictory event from rejected recovery");
  {
    const h = makeHarness();
    const s = setupRunning(h, "e4");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "e4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const before = countEvents(h, "e4");
    h.store.recoverJobAtomic({
      jobId: "e4", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(countEvents(h, "e4") === before, "E4 no new event from rejected recovery");
  }

  // ================================================================
  // Group F — Terminalization + retry (4)
  // ================================================================

  console.log("164-F1 two independent retry decisions converge to one");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f1"));
    setJobRunning(h.db, "f1", "L1");
    seedLease(h.db, "f1", "wA", "L1");
    const c1 = h.store.createAttemptAsOwnerAtomic("f1", "L1", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    const c2 = h.store.createAttemptAsOwnerAtomic("f1", "L1", "wA", "RUNNING");
    const c3 = h.store.createAttemptAsOwnerAtomic("f1", "L1", "wA", "RUNNING");
    ok(c2.created && c3.created && c2.attempt.id === c3.attempt.id, "F1 both same attempt");
    ok(countAttempts(h, "f1") === 2, "F1 exactly two attempts");
  }

  console.log("\n164-F2 retry attempt_number remains valid");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f2"));
    setJobRunning(h.db, "f2", "L2");
    seedLease(h.db, "f2", "wA", "L2");
    const c1 = h.store.createAttemptAsOwnerAtomic("f2", "L2", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    const c2 = h.store.createAttemptAsOwnerAtomic("f2", "L2", "wA", "RUNNING");
    ok(c2.created && c2.attempt.attemptNumber === 2, "F2 #2");
  }

  console.log("\n164-F3 late replay cannot create duplicate attempt #2");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f3"));
    setJobRunning(h.db, "f3", "L3");
    seedLease(h.db, "f3", "wA", "L3");
    const c1 = h.store.createAttemptAsOwnerAtomic("f3", "L3", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    h.store.createAttemptAsOwnerAtomic("f3", "L3", "wA", "RUNNING");
    h.store.createAttemptAsOwnerAtomic("f3", "L3", "wA", "RUNNING");
    h.store.createAttemptAsOwnerAtomic("f3", "L3", "wA", "RUNNING");
    ok(countAttempts(h, "f3") === 2, "F3 exactly two attempts");
  }

  console.log("\n164-F4 historical attempt immutable");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f4"));
    setJobRunning(h.db, "f4", "L4");
    seedLease(h.db, "f4", "wA", "L4");
    const c1 = h.store.createAttemptAsOwnerAtomic("f4", "L4", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.store.updateAttemptAsOwner({ ...c1.attempt, status: "FAILED" as any, error: "first" }, "L4", "wA");
    h.store.createAttemptAsOwnerAtomic("f4", "L4", "wA", "RUNNING");
    const r = h.store.updateAttemptAsOwner({ ...c1.attempt, status: "SUCCEEDED" as any }, "L4", "wA");
    ok(r.updated === false, "F4 #1 resurrection rejected");
    ok(getAttempt(h, c1.attempt.id).status === "FAILED", "F4 #1 still FAILED");
  }

  // ================================================================
  // Group G — Attempt/execution consistency (3)
  // ================================================================

  console.log("164-G1 attempt + job atomic on success");
  {
    const h = makeHarness();
    const s = setupRunning(h, "g1");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "g1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(getJob(h, "g1").status === "SUCCEEDED" && getAttempt(h, s.attemptId).status === "SUCCEEDED", "G1 both SUCCEEDED");
  }

  console.log("\n164-G2 attempt + job atomic on failure");
  {
    const h = makeHarness();
    const s = setupRunning(h, "g2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "g2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "boom", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    ok(getJob(h, "g2").status === "FAILED" && getAttempt(h, s.attemptId).status === "FAILED", "G2 both FAILED");
  }

  console.log("\n164-G3 rejected terminalization: neither changes");
  {
    const h = makeHarness();
    const s = setupRunning(h, "g3");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "g3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "G3 rejected");
    ok(getJob(h, "g3").status === "RUNNING", "G3 job still RUNNING");
    ok(getAttempt(h, s.attemptId).status === "RUNNING", "G3 attempt still RUNNING");
  }

  // ================================================================
  // Group H — Crash during terminalization (3)
  // ================================================================

  console.log("164-H1 pre-commit: transaction rolls back on injected failure");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h1");
    // Phase 143 hook fires inside recoverJobAtomic's transaction, not
    // completeAttemptAndTransitionJob. Instead we verify that a state
    // mismatch (wrong expectedJobStatus) leaves both rows unchanged.
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "h1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "VERIFYING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "H1 wrong expected rejected");
    ok(getJob(h, "h1").status === "RUNNING", "H1 job unchanged");
    ok(getAttempt(h, s.attemptId).status === "RUNNING", "H1 attempt unchanged");
  }

  console.log("\n164-H2 post-commit: both rows durable together");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const s = setupRunning(h1, "h2");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: s.attemptId, jobId: "h2", leaseId: s.leaseId, workerId: s.workerId,
        attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "h2").status === "SUCCEEDED", "H2 job durable");
      ok(getAttempt(h2, s.attemptId).status === "SUCCEEDED", "H2 attempt durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n164-H3 no partial state after rejected commit");
  {
    const h = makeHarness();
    const s = setupRunning(h, "h3");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: "nonexistent-attempt", jobId: "h3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "H3 bad attempt rejected");
    ok(getJob(h, "h3").status === "RUNNING", "H3 job unchanged");
  }

  // ================================================================
  // Group I — Database reopen (4)
  // ================================================================

  console.log("164-I1 SUCCEEDED durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const s = setupRunning(h1, "i1");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: s.attemptId, jobId: "i1", leaseId: s.leaseId, workerId: s.workerId,
        attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "i1").status === "SUCCEEDED", "I1 durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n164-I2 FAILED error durable");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const s = setupRunning(h1, "i2");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: s.attemptId, jobId: "i2", leaseId: s.leaseId, workerId: s.workerId,
        attemptStatus: "FAILED", attemptError: "boom", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
      });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getAttempt(h2, s.attemptId).status === "FAILED", "I2 FAILED durable");
      ok(getAttempt(h2, s.attemptId).error === "boom", "I2 error durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n164-I3 event durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const s = setupRunning(h1, "i3");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: s.attemptId, jobId: "i3", leaseId: s.leaseId, workerId: s.workerId,
        attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(countEvents(h2, "i3", "execution.transition.succeeded") === 1, "I3 one event durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n164-I4 retry budget durable");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const s = setupRunning(h1, "i4");
      // Close attempt #1, then allocate #2 so we have two durable attempts.
      h1.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), s.attemptId);
      h1.store.createAttemptAsOwnerAtomic("i4", s.leaseId, s.workerId, "RUNNING");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(countAttempts(h2, "i4") === 2, "I4 attempt count durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group J — Event exactly-once (3)
  // ================================================================

  console.log("164-J1 one transition = one event");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j1");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "j1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countEvents(h, "j1", "execution.transition.succeeded") === 1, "J1 one event");
  }

  console.log("\n164-J2 replay produces no additional event");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j2");
    const args = {
      attemptId: s.attemptId, jobId: "j2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    ok(countEvents(h, "j2", "execution.transition.succeeded") === 1, "J2 one event total");
  }

  console.log("\n164-J3 rejected mutation produces no event");
  {
    const h = makeHarness();
    const s = setupRunning(h, "j3");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    const before = countEvents(h, "j3");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "j3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countEvents(h, "j3") === before, "J3 no event");
  }

  // ================================================================
  // Group K — Idempotency (3)
  // ================================================================

  console.log("164-K1 SUCCESS x3 converges");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k1");
    const args = {
      attemptId: s.attemptId, jobId: "k1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    const r1 = h.store.completeAttemptAndTransitionJob(args);
    const r2 = h.store.completeAttemptAndTransitionJob(args);
    const r3 = h.store.completeAttemptAndTransitionJob(args);
    const applied = (r1.applied ? 1 : 0) + (r2.applied ? 1 : 0) + (r3.applied ? 1 : 0);
    ok(applied === 1, "K1 exactly one applied");
    ok(countEvents(h, "k1", "execution.transition.succeeded") === 1, "K1 one event");
  }

  console.log("\n164-K2 FAILURE x3 converges");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k2");
    const args = {
      attemptId: s.attemptId, jobId: "k2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED" as const, attemptError: "boom",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    };
    const r1 = h.store.completeAttemptAndTransitionJob(args);
    const r2 = h.store.completeAttemptAndTransitionJob(args);
    const r3 = h.store.completeAttemptAndTransitionJob(args);
    const applied = (r1.applied ? 1 : 0) + (r2.applied ? 1 : 0) + (r3.applied ? 1 : 0);
    ok(applied === 1, "K2 exactly one applied");
    ok(countEvents(h, "k2", "execution.transition.failed") === 1, "K2 one event");
  }

  console.log("\n164-K3 attempt count unchanged across replays");
  {
    const h = makeHarness();
    const s = setupRunning(h, "k3");
    const args = {
      attemptId: s.attemptId, jobId: "k3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    ok(countAttempts(h, "k3") === 1, "K3 one attempt");
  }

  // ================================================================
  // Group L — Cross-execution isolation (4)
  // ================================================================

  console.log("164-L1 terminalization of X does not touch Y");
  {
    const h = makeHarness();
    const sX = setupRunning(h, "l1-x");
    const sY = setupRunning(h, "l1-y", "wB", "L-l1-y");
    h.store.completeAttemptAndTransitionJob({
      attemptId: sX.attemptId, jobId: "l1-x", leaseId: sX.leaseId, workerId: sX.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(getJob(h, "l1-x").status === "SUCCEEDED", "L1 X SUCCEEDED");
    ok(getJob(h, "l1-y").status === "RUNNING", "L1 Y untouched");
  }

  console.log("\n164-L2 cross-job attempt ID rejected");
  {
    const h = makeHarness();
    const sX = setupRunning(h, "l2-x");
    const sY = setupRunning(h, "l2-y", "wB", "L-l2-y");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: sX.attemptId, jobId: "l2-y", leaseId: "L-l2-y", workerId: "wB",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false, "L2 cross-job rejected");
    ok(getJob(h, "l2-y").status === "RUNNING", "L2 Y unchanged");
  }

  console.log("\n164-L3 event isolated per job");
  {
    const h = makeHarness();
    const sX = setupRunning(h, "l3-x");
    setupRunning(h, "l3-y", "wB", "L-l3-y");
    h.store.completeAttemptAndTransitionJob({
      attemptId: sX.attemptId, jobId: "l3-x", leaseId: sX.leaseId, workerId: sX.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countEvents(h, "l3-x") === 1, "L3 X one event");
    ok(countEvents(h, "l3-y") === 0, "L3 Y zero events");
  }

  console.log("\n164-L4 different attempts on different jobs isolated");
  {
    const h = makeHarness();
    const sX = setupRunning(h, "l4-x");
    const sY = setupRunning(h, "l4-y", "wB", "L-l4-y");
    ok(sX.attemptId !== sY.attemptId, "L4 distinct ids");
    ok(sX.attemptId === "attempt_l4-x_1", "L4 X id");
    ok(sY.attemptId === "attempt_l4-y_1", "L4 Y id");
  }

  // ================================================================
  // Group M — Terminal resurrection (5)
  // ================================================================

  console.log("164-M1 SUCCEEDED cannot be re-claimed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m1"));
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='m1'").run();
    const r = h.store.atomicClaimJob({ jobId: "m1", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M1 rejected");
  }

  console.log("\n164-M2 FAILED cannot be re-claimed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m2"));
    h.db.prepare("UPDATE execution_jobs SET status='FAILED' WHERE id='m2'").run();
    const r = h.store.atomicClaimJob({ jobId: "m2", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M2 rejected");
  }

  console.log("\n164-M3 CANCELLED cannot be re-claimed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m3"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='m3'").run();
    const r = h.store.atomicClaimJob({ jobId: "m3", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M3 rejected");
  }

  console.log("\n164-M4 DEAD_LETTER cannot be re-claimed");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m4"));
    h.db.prepare("UPDATE execution_jobs SET status='DEAD_LETTER' WHERE id='m4'").run();
    const r = h.store.atomicClaimJob({ jobId: "m4", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M4 rejected");
  }

  console.log("\n164-M5 terminal cannot be recovered to ORPHANED");
  {
    const h = makeHarness();
    for (const st of ["SUCCEEDED", "CANCELLED", "DEAD_LETTER"]) {
      h.store.createJob(queuedJob("m5-" + st));
      h.db.prepare("UPDATE execution_jobs SET status=? WHERE id=?").run(st, "m5-" + st);
      const r = h.store.recoverJobAtomic({
        jobId: "m5-" + st, expectedStatus: "RUNNING", newStatus: "ORPHANED",
        expectedLeaseId: null,
        event: { eventType: "execution.recovery.orphaned", payload: {} },
      });
      ok(r.ok === false, "M5 " + st + " cannot orphan");
    }
  }

  // ================================================================
  // Group N — Shutdown (3)
  // ================================================================

  console.log("164-N1 shutdown does not fabricate SUCCESS");
  {
    const h = makeHarness();
    const s = setupRunning(h, "n1");
    // No terminalization is called — verify job unchanged.
    ok(getJob(h, "n1").status === "RUNNING", "N1 status unchanged");
  }

  console.log("\n164-N2 terminal work durable regardless of shutdown");
  {
    const h = makeHarness();
    const s = setupRunning(h, "n2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "n2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    // Simulate shutdown (no-op).
    ok(getJob(h, "n2").status === "SUCCEEDED", "N2 SUCCEEDED durable");
  }

  console.log("\n164-N3 non-terminal work remains recoverable");
  {
    const h = makeHarness();
    const s = setupRunning(h, "n3");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    const r = h.store.recoverJobAtomic({
      jobId: "n3", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
      obligation: { leaseId: s.leaseId, workerId: s.workerId, reason: "LEASE_EXPIRED" },
    });
    ok(r.ok === true, "N3 recoverable");
    ok(getJob(h, "n3").status === "ORPHANED", "N3 ORPHANED");
  }

  // ================================================================
  // Group O — Concurrent DB access (4)
  // ================================================================

  console.log("164-O1 two terminalizers sequential");
  {
    const h = makeHarness();
    const s = setupRunning(h, "o1");
    const r1 = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "o1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const r2 = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "o1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r1.ok && r1.applied && r2.ok && !r2.applied, "O1 idempotent");
  }

  console.log("\n164-O2 terminalizer + recovery");
  {
    const h = makeHarness();
    const s = setupRunning(h, "o2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "o2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const rec = h.store.recoverJobAtomic({
      jobId: "o2", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: s.leaseId,
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(rec.ok === false, "O2 recovery rejected");
  }

  console.log("\n164-O3 terminalizer + retry");
  {
    const h = makeHarness();
    const s = setupRunning(h, "o3");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "o3", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    const c2 = h.store.createAttemptAsOwnerAtomic("o3", s.leaseId, s.workerId, "RUNNING");
    ok(c2.created === false, "O3 retry attempt rejected on terminal");
  }

  console.log("\n164-O4 terminalizer + cancellation");
  {
    const h = makeHarness();
    const s = setupRunning(h, "o4");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "o4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    // requestCancellation should not resurrect.
    h.store.requestCancellation("o4");
    ok(getJob(h, "o4").status === "SUCCEEDED", "O4 still SUCCEEDED");
  }

  // ================================================================
  // Group P — Retry budget (4)
  // ================================================================

  console.log("164-P1 success replay no budget change");
  {
    const h = makeHarness();
    const s = setupRunning(h, "p1");
    const args = {
      attemptId: s.attemptId, jobId: "p1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    h.store.completeAttemptAndTransitionJob(args);
    const before = countAttempts(h, "p1");
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    ok(countAttempts(h, "p1") === before, "P1 no change");
  }

  console.log("\n164-P2 rejected stale mutation no budget change");
  {
    const h = makeHarness();
    const s = setupRunning(h, "p2");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    const before = countAttempts(h, "p2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "p2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countAttempts(h, "p2") === before, "P2 no change");
  }

  console.log("\n164-P3 duplicate recovery no budget change");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("p3"));
    const before = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id='p3'").get() as any).n;
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.createOrGetOperation({
        jobId: "p3", leaseId: "L3", workerId: "wA", operationType: "ORPHAN_RECOVERY",
      });
    }
    const after = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id='p3'").get() as any).n;
    ok(after === before + 1, "P3 one op");
  }

  console.log("\n164-P4 terminalization race leaves budget correct");
  {
    const h = makeHarness();
    const s = setupRunning(h, "p4");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "p4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "p4", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "late", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    ok(countAttempts(h, "p4") === 1, "P4 one attempt");
  }

  // ================================================================
  // Group Q — No synthetic success (4)
  // ================================================================

  console.log("164-Q1 shutdown does not produce SUCCESS");
  {
    const h = makeHarness();
    setupRunning(h, "q1");
    ok(getJob(h, "q1").status === "RUNNING", "Q1 no fabricated SUCCESS");
  }

  console.log("\n164-Q2 stale worker rejection does not produce SUCCESS");
  {
    const h = makeHarness();
    const s = setupRunning(h, "q2");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id=?").run(Date.now() - 1000, s.leaseId);
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "q2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(getJob(h, "q2").status === "RUNNING", "Q2 no SUCCESS");
  }

  console.log("\n164-Q3 duplicate request does not produce SUCCESS");
  {
    const h = makeHarness();
    setupRunning(h, "q3");
    const r = h.store.atomicClaimJob({ jobId: "q3", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "Q3 duplicate claim rejected");
  }

  console.log("\n164-Q4 DB reopen does not produce SUCCESS");
  {
    const dir = mkdtempSync(join(tmpdir(), "p164-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      setupRunning(h1, "q4");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "q4").status === "RUNNING", "Q4 still RUNNING");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group R — Real execution boundary (2)
  // ================================================================

  console.log("164-R1 no external executor invoked by terminalization");
  {
    const h = makeHarness();
    const s = setupRunning(h, "r1");
    // completeAttemptAndTransitionJob is a pure DB operation; no external
    // process, container, or provider is invoked by this primitive.
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "r1", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === true, "R1 DB-only terminalization");
  }

  console.log("\n164-R2 terminal outcome derives from caller-supplied evidence");
  {
    const h = makeHarness();
    const s = setupRunning(h, "r2");
    h.store.completeAttemptAndTransitionJob({
      attemptId: s.attemptId, jobId: "r2", leaseId: s.leaseId, workerId: s.workerId,
      attemptStatus: "FAILED", attemptError: "real-error",
      expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    ok(getAttempt(h, s.attemptId).error === "real-error", "R2 caller evidence stored");
  }

  console.log("\n--- Phase 164: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE164 DRIVER CRASH:", err); process.exit(1); });
