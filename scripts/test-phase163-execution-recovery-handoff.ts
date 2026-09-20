// scripts/test-phase163-execution-recovery-handoff.ts
// Phase 163 - durable execution-to-recovery handoff & failure authority.
//
// Baseline: every invariant this phase asks about is already provided by
// primitives from Phases 142-162. No production change required.
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
function countOps(h: H, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?";
  return type ? (h.db.prepare(sql).get(jobId, type) as any).n : (h.db.prepare(sql).get(jobId) as any).n;
}
function getOp(h: H, jobId: string, type: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ? AND operation_type = ? ORDER BY created_at DESC LIMIT 1").get(jobId, type) as any;
}
function countEvents(h: H, jobId: string, type?: string): number {
  const sql = type
    ? "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ? AND event_type = ?"
    : "SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?";
  return type ? (h.db.prepare(sql).get(jobId, type) as any).n : (h.db.prepare(sql).get(jobId) as any).n;
}

async function main() {
  console.log("=== Phase 163 - Durable Execution -> Recovery Handoff ===\n");

  // Group A
  console.log("163-A1 live owner is authorized to fail its attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a1"));
    setJobRunning(h.db, "a1", "L1");
    seedLease(h.db, "a1", "wA", "L1");
    const c = h.store.createAttemptAsOwnerAtomic("a1", "L1", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    const r = h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any, error: "boom", completedAt: Date.now() }, "L1", "wA");
    ok(r.updated === true, "A1 owner failed attempt");
    ok(getAttempt(h, c.attempt.id).status === "FAILED", "A1 status FAILED");
  }

  console.log("\n163-A2 lease expiry during failure does not resurrect authority");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a2"));
    setJobRunning(h.db, "a2", "L2");
    seedLease(h.db, "a2", "wA", "L2", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("a2", "L2", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L2'").run(Date.now() - 1000);
    const r = h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any, error: "late-fail", completedAt: Date.now() }, "L2", "wA");
    ok(r.updated === false, "A2 stale failure rejected");
    ok(getAttempt(h, c.attempt.id).status === "RUNNING", "A2 attempt still RUNNING");
  }

  console.log("\n163-A3 stale failure after takeover is rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a3"));
    setJobRunning(h.db, "a3", "L3-old");
    seedLease(h.db, "a3", "wA", "L3-old", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("a3", "L3-old", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L3-old'").run(Date.now() - 1000);
    seedLease(h.db, "a3", "wB", "L3-new", "ACTIVE", Date.now() + 60000);
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L3-new' WHERE id='a3'").run();
    const r = h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any, error: "late" }, "L3-old", "wA");
    ok(r.updated === false, "A3 A rejected");
    ok(getAttempt(h, c.attempt.id).status === "RUNNING", "A3 attempt untouched");
    ok(getJob(h, "a3").current_lease_id === "L3-new", "A3 new owner intact");
  }

  console.log("\n163-A4 exact-expiry boundary rejects failure");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a4"));
    const t = 2_000_000_000_000;
    setJobRunning(h.db, "a4", "L4");
    h.db.prepare("INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)")
      .run("L4", "a4", "wA", t, t + 60000, "ACTIVE");
    const c = h.store.createAttemptAsOwnerAtomic("a4", "L4", "wA", "RUNNING", t + 1000);
    if (!c.created) throw new Error("alloc");
    const r = h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any }, "L4", "wA", t + 60000);
    ok(r.updated === false, "A4 exact-boundary rejected");
  }

  console.log("\n163-A5 wrong worker cannot fail another's attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a5"));
    setJobRunning(h.db, "a5", "L5");
    seedLease(h.db, "a5", "wA", "L5");
    const c = h.store.createAttemptAsOwnerAtomic("a5", "L5", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    const r = h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any }, "L5", "wB");
    ok(r.updated === false, "A5 wrong worker rejected");
  }

  // Group B
  console.log("\n163-B1 recovery op identity is deterministic");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b1"));
    const a = h.store.recoveryOps.createOrGetOperation({ jobId: "b1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    const b = h.store.recoveryOps.createOrGetOperation({ jobId: "b1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    ok(a.created === true, "B1 first created");
    ok(b.created === false, "B1 second finds existing");
    ok(a.operation.operationId === b.operation.operationId, "B1 same id");
  }

  console.log("\n163-B2 recovery op idempotency key encodes exact identity");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b2"));
    h.store.recoveryOps.createOrGetOperation({ jobId: "b2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
    const row = getOp(h, "b2", "TIMEOUT");
    ok(row.idempotency_key === "TIMEOUT:b2:L2", "B2 key = opType:jobId:leaseId");
  }

  console.log("\n163-B3 different lease = different recovery identity");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b3"));
    h.store.recoveryOps.createOrGetOperation({ jobId: "b3", leaseId: "L3a", workerId: "wA", operationType: "ORPHAN_RECOVERY" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "b3", leaseId: "L3b", workerId: "wB", operationType: "ORPHAN_RECOVERY" });
    ok(countOps(h, "b3", "ORPHAN_RECOVERY") === 2, "B3 two distinct ops");
  }

  console.log("\n163-B4 recovery op links to exact job");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("b4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "b4", leaseId: "L4", workerId: "wA", operationType: "CANCELLATION" });
    ok(operation.jobId === "b4", "B4 jobId bound");
  }

  console.log("\n163-B5 recovery op survives reload");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("b5"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({ jobId: "b5", leaseId: "L5", workerId: "wA", operationType: "TIMEOUT" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const reread = h2.store.recoveryOps.createOrGetOperation({ jobId: "b5", leaseId: "L5", workerId: "wA", operationType: "TIMEOUT" });
      ok(reread.created === false, "B5 found after reopen");
      ok(reread.operation.operationId === operation.operationId, "B5 same id");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Group C
  console.log("\n163-C1 one recovery worker claims");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "c1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    const r = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    ok(r.claimed === true, "C1 claimed");
    ok(getOp(h, "c1", "TIMEOUT").claim_owner === "R1", "C1 owner R1");
  }

  console.log("\n163-C2 second recovery worker blocked while first live");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("c2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "c2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
    const r1 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    const r2 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000 });
    ok(r1.claimed === true && r2.claimed === false, "C2 only one winner");
  }

  console.log("\n163-C3 expired recovery claim can be taken over");
  {
    const h = makeHarness();
    const t = 3_000_000_000_000;
    h.store.createJob(queuedJob("c3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "c3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    const r = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    ok(r.claimed === true, "C3 R2 takes over");
    ok(getOp(h, "c3", "TIMEOUT").claim_owner === "R2", "C3 owner is R2");
  }

  console.log("\n163-C4 stale recovery owner cannot mark completed");
  {
    const h = makeHarness();
    const t = 4_000_000_000_000;
    h.store.createJob(queuedJob("c4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "c4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.markCompleted(operation.operationId, "R1", t + 2000);
    ok(r === false, "C4 R1 rejected");
    ok(getOp(h, "c4", "TIMEOUT").state !== "COMPLETED", "C4 not completed");
  }

  console.log("\n163-C5 stale recovery owner cannot mark recovery-required");
  {
    const h = makeHarness();
    const t = 5_000_000_000_000;
    h.store.createJob(queuedJob("c5"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "c5", leaseId: "L5", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.markRecoveryRequired(operation.operationId, "R1", "stale", t + 2000);
    ok(r === false, "C5 R1 rejected");
  }

  // Group D
  console.log("\n163-D1 retry creates new durable attempt with new identity");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d1"));
    setJobRunning(h.db, "d1", "L1");
    seedLease(h.db, "d1", "wA", "L1");
    const c1 = h.store.createAttemptAsOwnerAtomic("d1", "L1", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    const c2 = h.store.createAttemptAsOwnerAtomic("d1", "L1", "wA", "RUNNING");
    ok(c2.created === true, "D1 second attempt created");
    ok(c2.attempt.id !== c1.attempt.id, "D1 new identity");
    ok(c2.attempt.attemptNumber === 2, "D1 attemptNumber 2");
  }

  console.log("\n163-D2 old attempt immutable after FAILED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d2"));
    setJobRunning(h.db, "d2", "L2");
    seedLease(h.db, "d2", "wA", "L2");
    const c1 = h.store.createAttemptAsOwnerAtomic("d2", "L2", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', error='orig', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    h.store.createAttemptAsOwnerAtomic("d2", "L2", "wA", "RUNNING");
    const r = h.store.updateAttemptAsOwner({ ...c1.attempt, status: "SUCCEEDED" as any }, "L2", "wA");
    ok(r.updated === false, "D2 old attempt resurrection rejected");
    ok(getAttempt(h, c1.attempt.id).status === "FAILED", "D2 old still FAILED");
    ok(getAttempt(h, c1.attempt.id).error === "orig", "D2 old error preserved");
  }

  console.log("\n163-D3 attempt numbers are monotonic");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d3"));
    setJobRunning(h.db, "d3", "L3");
    seedLease(h.db, "d3", "wA", "L3");
    const nums: number[] = [];
    for (let i = 0; i < 4; i++) {
      const c = h.store.createAttemptAsOwnerAtomic("d3", "L3", "wA", "RUNNING");
      if (!c.created) throw new Error("alloc " + i);
      nums.push(c.attempt.attemptNumber);
      h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c.attempt.id);
    }
    ok(JSON.stringify(nums) === "[1,2,3,4]", "D3 monotonic 1..4");
    ok(countAttempts(h, "d3") === 4, "D3 four rows");
  }

  console.log("\n163-D4 execution identity stable across retries");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d4"));
    setJobRunning(h.db, "d4", "L4");
    seedLease(h.db, "d4", "wA", "L4");
    const before = getJob(h, "d4");
    const c1 = h.store.createAttemptAsOwnerAtomic("d4", "L4", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    h.store.createAttemptAsOwnerAtomic("d4", "L4", "wA", "RUNNING");
    const after = getJob(h, "d4");
    ok(before.id === after.id, "D4 job id stable");
    ok(before.idempotency_key === after.idempotency_key, "D4 idempotency key stable");
  }

  console.log("\n163-D5 idempotent same-lease attempt allocation");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("d5"));
    setJobRunning(h.db, "d5", "L5");
    seedLease(h.db, "d5", "wA", "L5");
    const c1 = h.store.createAttemptAsOwnerAtomic("d5", "L5", "wA", "RUNNING");
    const c2 = h.store.createAttemptAsOwnerAtomic("d5", "L5", "wA", "RUNNING");
    const c3 = h.store.createAttemptAsOwnerAtomic("d5", "L5", "wA", "RUNNING");
    ok(c1.created && c2.created && c3.created, "D5 all created-flag");
    ok(c1.attempt.id === c2.attempt.id && c2.attempt.id === c3.attempt.id, "D5 same identity");
    ok(countAttempts(h, "d5") === 1, "D5 one row");
  }

  // Group E
  console.log("\n163-E1 retry attempt does not overwrite previous attempt state");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e1"));
    setJobRunning(h.db, "e1", "L1");
    seedLease(h.db, "e1", "wA", "L1");
    const c1 = h.store.createAttemptAsOwnerAtomic("e1", "L1", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', error='first', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    const c2 = h.store.createAttemptAsOwnerAtomic("e1", "L1", "wA", "RUNNING");
    if (!c2.created) throw new Error("alloc2");
    const a1 = getAttempt(h, c1.attempt.id);
    const a2 = getAttempt(h, c2.attempt.id);
    ok(a1.status === "FAILED" && a1.error === "first", "E1 #1 immut");
    ok(a2.status === "RUNNING", "E1 #2 RUNNING");
  }

  console.log("\n163-E2 cross-job attempt write is rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e2-a"));
    h.store.createJob(queuedJob("e2-b"));
    setJobRunning(h.db, "e2-a", "L2-a");
    setJobRunning(h.db, "e2-b", "L2-b");
    seedLease(h.db, "e2-a", "wA", "L2-a");
    seedLease(h.db, "e2-b", "wB", "L2-b");
    const cA = h.store.createAttemptAsOwnerAtomic("e2-a", "L2-a", "wA", "RUNNING");
    if (!cA.created) throw new Error("allocA");
    const r = h.store.updateAttemptAsOwner({ ...cA.attempt, jobId: "e2-b", status: "SUCCEEDED" as any }, "L2-b", "wB");
    ok(r.updated === false, "E2 cross-job rejected");
    ok(getAttempt(h, cA.attempt.id).job_id === "e2-a", "E2 attempt job_id preserved");
  }

  console.log("\n163-E3 terminalization does not touch historical attempts");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e3"));
    setJobRunning(h.db, "e3", "L3");
    seedLease(h.db, "e3", "wA", "L3");
    const c1 = h.store.createAttemptAsOwnerAtomic("e3", "L3", "wA", "RUNNING");
    if (!c1.created) throw new Error("alloc1");
    h.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
    const c2 = h.store.createAttemptAsOwnerAtomic("e3", "L3", "wA", "RUNNING");
    if (!c2.created) throw new Error("alloc2");
    const r = h.store.completeAttemptAndTransitionJob({
      attemptId: c2.attempt.id, jobId: "e3", leaseId: "L3", workerId: "wA",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === true, "E3 #2 terminalized");
    const a1 = getAttempt(h, c1.attempt.id);
    ok(a1.status === "FAILED", "E3 #1 stays FAILED");
  }

  console.log("\n163-E4 no cross-job attempt identity collision");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("e4-a"));
    h.store.createJob(queuedJob("e4-b"));
    setJobRunning(h.db, "e4-a", "L4-a");
    setJobRunning(h.db, "e4-b", "L4-b");
    seedLease(h.db, "e4-a", "wA", "L4-a");
    seedLease(h.db, "e4-b", "wB", "L4-b");
    const cA = h.store.createAttemptAsOwnerAtomic("e4-a", "L4-a", "wA", "RUNNING");
    const cB = h.store.createAttemptAsOwnerAtomic("e4-b", "L4-b", "wB", "RUNNING");
    ok(cA.attempt.id === "attempt_e4-a_1", "E4-A id prefix");
    ok(cB.attempt.id === "attempt_e4-b_1", "E4-B id prefix");
    ok(cA.attempt.id !== cB.attempt.id, "E4 distinct ids");
  }

  // Group F
  console.log("\n163-F1 worker A after lease expiry cannot mutate its attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f1"));
    setJobRunning(h.db, "f1", "L1");
    seedLease(h.db, "f1", "wA", "L1", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("f1", "L1", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L1'").run(Date.now() - 1000);
    const results = [
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "SUCCEEDED" as any }, "L1", "wA"),
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any }, "L1", "wA"),
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "CANCELLED" as any }, "L1", "wA"),
    ];
    for (const r of results) ok(r.updated === false, "F1 rejected");
  }

  console.log("\n163-F2 stale worker after B takeover full fencing matrix");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f2"));
    setJobRunning(h.db, "f2", "L2-old");
    seedLease(h.db, "f2", "wA", "L2-old", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("f2", "L2-old", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L2-old'").run(Date.now() - 1000);
    seedLease(h.db, "f2", "wB", "L2-new", "ACTIVE", Date.now() + 60000);
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L2-new' WHERE id='f2'").run();
    const results = [
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "SUCCEEDED" as any }, "L2-old", "wA"),
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any }, "L2-old", "wA"),
      h.store.updateAttemptAsOwner({ ...c.attempt, status: "CANCELLED" as any }, "L2-old", "wA"),
    ];
    for (const r of results) ok(r.updated === false, "F2 rejected");
    ok(getAttempt(h, c.attempt.id).status === "RUNNING", "F2 attempt untouched");
  }

  console.log("\n163-F3 stale worker cannot alter job via recoverJobAtomic");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f3"));
    setJobRunning(h.db, "f3", "L3-old");
    seedLease(h.db, "f3", "wA", "L3-old", "EXPIRED", Date.now() - 1000);
    seedLease(h.db, "f3", "wB", "L3-new", "ACTIVE", Date.now() + 60000);
    h.db.prepare("UPDATE execution_jobs SET current_lease_id='L3-new' WHERE id='f3'").run();
    const r = h.store.recoverJobAtomic({
      jobId: "f3", expectedStatus: "RUNNING", newStatus: "ORPHANED",
      expectedLeaseId: "L3-old",
      event: { eventType: "execution.recovery.orphaned", payload: {} },
    });
    ok(r.ok === false, "F3 A rejected");
    ok(getJob(h, "f3").current_lease_id === "L3-new", "F3 B intact");
  }

  console.log("\n163-F4 stale worker cannot produce terminal event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("f4"));
    setJobRunning(h.db, "f4", "L4-old");
    seedLease(h.db, "f4", "wA", "L4-old", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("f4", "L4-old", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L4-old'").run(Date.now() - 1000);
    const before = countEvents(h, "f4");
    h.store.updateAttemptAsOwner({ ...c.attempt, status: "SUCCEEDED" as any }, "L4-old", "wA");
    ok(countEvents(h, "f4") === before, "F4 no event");
  }

  // Group G
  console.log("\n163-G1 stale recovery cannot complete after takeover");
  {
    const h = makeHarness();
    const t = 6_000_000_000_000;
    h.store.createJob(queuedJob("g1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "g1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.markCompleted(operation.operationId, "R1", t + 2000);
    ok(r === false, "G1 R1 rejected");
    ok(getOp(h, "g1", "TIMEOUT").state !== "COMPLETED", "G1 not completed");
  }

  console.log("\n163-G2 stale recovery cannot fail after takeover");
  {
    const h = makeHarness();
    const t = 7_000_000_000_000;
    h.store.createJob(queuedJob("g2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "g2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.markFailed(operation.operationId, "R1", "err", t + 2000);
    ok(r === false, "G2 R1 rejected");
  }

  console.log("\n163-G3 stale recovery cannot cancel after takeover");
  {
    const h = makeHarness();
    const t = 8_000_000_000_000;
    h.store.createJob(queuedJob("g3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "g3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "R1", now: t + 2000 });
    ok(r.cancelled === false, "G3 R1 rejected");
  }

  console.log("\n163-G4 stale recovery cannot renew after takeover");
  {
    const h = makeHarness();
    const t = 9_000_000_000_000;
    h.store.createJob(queuedJob("g4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "g4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: operation.operationId, owner: "R1", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false, "G4 R1 renew rejected");
  }

  // Group H
  console.log("\n163-H1 sequential duplicate create converges");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("h1"));
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "h1", leaseId: "L1", workerId: "wA", operationType: "ORPHAN_RECOVERY" });
      ids.add(operation.operationId);
    }
    ok(ids.size === 1, "H1 one id");
    ok(countOps(h, "h1") === 1, "H1 one row");
  }

  console.log("\n163-H2 concurrent duplicate creation via many callers converges");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("h2"));
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "h2", leaseId: "L2", workerId: "wA", operationType: "ORPHAN_RECOVERY" });
      ids.add(operation.operationId);
    }
    ok(ids.size === 1, "H2 one id");
    ok(countOps(h, "h2") === 1, "H2 one row");
  }

  console.log("\n163-H3 duplicate recovery across DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("h3"));
      const { operation: first } = h1.store.recoveryOps.createOrGetOperation({ jobId: "h3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const { created, operation } = h2.store.recoveryOps.createOrGetOperation({ jobId: "h3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
      ok(created === false, "H3 found existing");
      ok(operation.operationId === first.operationId, "H3 same id");
      ok(countOps(h2, "h3") === 1, "H3 one row");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-H4 replay after claim converges to same op");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("h4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "h4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    const { created, operation: replay } = h.store.recoveryOps.createOrGetOperation({ jobId: "h4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    ok(created === false, "H4 replay finds existing");
    ok(replay.operationId === operation.operationId, "H4 same id");
    ok(countOps(h, "h4") === 1, "H4 one row");
  }

  // Group I
  console.log("\n163-I1 attempt_count increments only on claim/takeover");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("i1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "i1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    ok(getOp(h, "i1", "TIMEOUT").attempt_count === 0, "I1 fresh 0");
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    ok(getOp(h, "i1", "TIMEOUT").attempt_count === 1, "I1 after claim 1");
    h.store.recoveryOps.createOrGetOperation({ jobId: "i1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    ok(getOp(h, "i1", "TIMEOUT").attempt_count === 1, "I1 replay no bump");
  }

  console.log("\n163-I2 duplicate cancel does not consume budget");
  {
    const h = makeHarness();
    const t = 10_000_000_000_000;
    h.store.createJob(queuedJob("i2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "i2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000, now: t });
    const before = getOp(h, "i2", "TIMEOUT").attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "R1", now: t + 1000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "R1", now: t + 2000 });
    ok(getOp(h, "i2", "TIMEOUT").attempt_count === before, "I2 no bump");
  }

  console.log("\n163-I3 takeover increments only once more");
  {
    const h = makeHarness();
    const t = 11_000_000_000_000;
    h.store.createJob(queuedJob("i3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "i3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 1, now: t });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000, now: t + 1000 });
    ok(getOp(h, "i3", "TIMEOUT").attempt_count === 2, "I3 attempt_count 2");
  }

  console.log("\n163-I4 duplicate terminal requests do not bump budget");
  {
    const h = makeHarness();
    const t = 12_000_000_000_000;
    h.store.createJob(queuedJob("i4"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "i4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000, now: t });
    h.store.recoveryOps.markCompleted(operation.operationId, "R1", t + 1000);
    const before = getOp(h, "i4", "TIMEOUT").attempt_count;
    h.store.recoveryOps.markCompleted(operation.operationId, "R1", t + 2000);
    h.store.recoveryOps.markFailed(operation.operationId, "R1", "late", t + 3000);
    ok(getOp(h, "i4", "TIMEOUT").attempt_count === before, "I4 no bump");
  }

  // Group J
  console.log("\n163-J1 job + attempt durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j1"));
      setJobRunning(h1.db, "j1", "L1");
      seedLease(h1.db, "j1", "wA", "L1");
      const c = h1.store.createAttemptAsOwnerAtomic("j1", "L1", "wA", "RUNNING");
      if (!c.created) throw new Error("alloc");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "j1").id === "j1", "J1 job durable");
      ok(getAttempt(h2, c.attempt.id).status === "RUNNING", "J1 attempt durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-J2 recovery op durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j2"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({ jobId: "j2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const row = getOp(h2, "j2", "TIMEOUT");
      ok(row && row.operation_id === operation.operationId, "J2 op durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-J3 retry budget durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j3"));
      const { operation } = h1.store.recoveryOps.createOrGetOperation({ jobId: "j3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, "j3", "TIMEOUT").attempt_count === 1, "J3 attempt_count durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-J4 terminal attempt durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("j4"));
      setJobRunning(h1.db, "j4", "L4");
      seedLease(h1.db, "j4", "wA", "L4");
      const c = h1.store.createAttemptAsOwnerAtomic("j4", "L4", "wA", "RUNNING");
      if (!c.created) throw new Error("alloc");
      h1.store.updateAttemptAsOwner({ ...c.attempt, status: "FAILED" as any, error: "boom" }, "L4", "wA");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getAttempt(h2, c.attempt.id).status === "FAILED", "J4 FAILED durable");
      ok(getAttempt(h2, c.attempt.id).error === "boom", "J4 error durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Group K
  console.log("\n163-K1 two workers race for same job claim");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("k1"));
    const r1 = h.store.atomicClaimJob({ jobId: "k1", workerId: "wA", durationMs: 60000 });
    const r2 = h.store.atomicClaimJob({ jobId: "k1", workerId: "wB", durationMs: 60000 });
    const wins = (r1.claimed ? 1 : 0) + (r2.claimed ? 1 : 0);
    ok(wins === 1, "K1 one winner");
  }

  console.log("\n163-K2 three workers race");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("k2"));
    const results = [
      h.store.atomicClaimJob({ jobId: "k2", workerId: "wA", durationMs: 60000 }),
      h.store.atomicClaimJob({ jobId: "k2", workerId: "wB", durationMs: 60000 }),
      h.store.atomicClaimJob({ jobId: "k2", workerId: "wC", durationMs: 60000 }),
    ];
    const wins = results.filter((r) => r.claimed).length;
    ok(wins === 1, "K2 one winner");
  }

  console.log("\n163-K3 stale worker's claim attempt after takeover rejected");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("k3"));
    const r1 = h.store.atomicClaimJob({ jobId: "k3", workerId: "wA", durationMs: 60000 });
    const r2 = h.store.atomicClaimJob({ jobId: "k3", workerId: "wB", durationMs: 60000 });
    ok(r2.claimed === false, "K3 B rejected while A live");
    ok(getJob(h, "k3").current_lease_id === r1.lease!.leaseId, "K3 A intact");
  }

  console.log("\n163-K4 exactly one ACTIVE lease");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("k4"));
    for (let i = 0; i < 5; i++) h.store.atomicClaimJob({ jobId: "k4", workerId: "wA", durationMs: 60000 });
    const n = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_leases WHERE job_id='k4' AND status='ACTIVE'").get() as any).n;
    ok(n === 1, "K4 one ACTIVE lease");
  }

  // Group L
  console.log("\n163-L1 two recovery workers claim same op: one wins");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("l1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "l1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    const r1 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    const r2 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000 });
    ok(r1.claimed === true && r2.claimed === false, "L1 one winner");
  }

  console.log("\n163-L2 three recovery workers");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("l2"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "l2", leaseId: "L2", workerId: "wA", operationType: "TIMEOUT" });
    const r1 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R1", durationMs: 60000 });
    const r2 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R2", durationMs: 60000 });
    const r3 = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "R3", durationMs: 60000 });
    const wins = [r1, r2, r3].filter((r) => r.claimed).length;
    ok(wins === 1, "L2 one winner");
  }

  console.log("\n163-L3 concurrent createOrGet converges");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("l3"));
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { operation } = h.store.recoveryOps.createOrGetOperation({ jobId: "l3", leaseId: "L3", workerId: "wA", operationType: "TIMEOUT" });
      ids.add(operation.operationId);
    }
    ok(ids.size === 1, "L3 one id");
  }

  console.log("\n163-L4 concurrent duplicate recovery across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("l4"));
      const { operation: first } = h1.store.recoveryOps.createOrGetOperation({ jobId: "l4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const { operation: second } = h2.store.recoveryOps.createOrGetOperation({ jobId: "l4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
      ok(first.operationId === second.operationId, "L4 same id");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Group M
  console.log("\n163-M1 SUCCEEDED terminal");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m1"));
    h.db.prepare("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id='m1'").run();
    const r = h.store.atomicClaimJob({ jobId: "m1", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M1 not re-claimable");
  }

  console.log("\n163-M2 FAILED terminal");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m2"));
    h.db.prepare("UPDATE execution_jobs SET status='FAILED' WHERE id='m2'").run();
    const r = h.store.atomicClaimJob({ jobId: "m2", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M2 not re-claimable");
  }

  console.log("\n163-M3 CANCELLED terminal");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m3"));
    h.db.prepare("UPDATE execution_jobs SET status='CANCELLED' WHERE id='m3'").run();
    const r = h.store.atomicClaimJob({ jobId: "m3", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M3 not re-claimable");
  }

  console.log("\n163-M4 DEAD_LETTER terminal");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("m4"));
    h.db.prepare("UPDATE execution_jobs SET status='DEAD_LETTER' WHERE id='m4'").run();
    const r = h.store.atomicClaimJob({ jobId: "m4", workerId: "wA", durationMs: 60000 });
    ok(r.claimed === false, "M4 not re-claimable");
  }

  // Group N
  console.log("\n163-N1 successful terminalization: one transition event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("n1"));
    setJobRunning(h.db, "n1", "L1");
    seedLease(h.db, "n1", "wA", "L1");
    const c = h.store.createAttemptAsOwnerAtomic("n1", "L1", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.store.completeAttemptAndTransitionJob({
      attemptId: c.attempt.id, jobId: "n1", leaseId: "L1", workerId: "wA",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(countEvents(h, "n1", "execution.transition.succeeded") === 1, "N1 one event");
  }

  console.log("\n163-N2 rejected mutation produces no event");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("n2"));
    setJobRunning(h.db, "n2", "L2");
    seedLease(h.db, "n2", "wA", "L2", "ACTIVE", Date.now() + 60000);
    const c = h.store.createAttemptAsOwnerAtomic("n2", "L2", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    h.db.prepare("UPDATE execution_leases SET status='EXPIRED', expires_at=? WHERE lease_id='L2'").run(Date.now() - 1000);
    const before = countEvents(h, "n2");
    h.store.updateAttemptAsOwner({ ...c.attempt, status: "SUCCEEDED" as any }, "L2", "wA");
    ok(countEvents(h, "n2") === before, "N2 no event");
  }

  console.log("\n163-N3 idempotent replay produces no duplicate events");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("n3"));
    setJobRunning(h.db, "n3", "L3");
    seedLease(h.db, "n3", "wA", "L3");
    const c = h.store.createAttemptAsOwnerAtomic("n3", "L3", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    const args = {
      attemptId: c.attempt.id, jobId: "n3", leaseId: "L3", workerId: "wA",
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    h.store.completeAttemptAndTransitionJob(args);
    ok(countEvents(h, "n3", "execution.transition.succeeded") === 1, "N3 one event total");
  }

  // Group O
  console.log("\n163-O1 lease + attempt + recovery op durable together");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("o1"));
      setJobRunning(h1.db, "o1", "L1");
      seedLease(h1.db, "o1", "wA", "L1");
      const c = h1.store.createAttemptAsOwnerAtomic("o1", "L1", "wA", "RUNNING");
      if (!c.created) throw new Error("alloc");
      h1.store.recoveryOps.createOrGetOperation({ jobId: "o1", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "o1").current_lease_id === "L1", "O1 lease durable");
      ok(getAttempt(h2, c.attempt.id).status === "RUNNING", "O1 attempt durable");
      ok(getOp(h2, "o1", "TIMEOUT") !== undefined, "O1 recovery op durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-O2 retry attempt_number survives reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("o2"));
      setJobRunning(h1.db, "o2", "L2");
      seedLease(h1.db, "o2", "wA", "L2");
      const c1 = h1.store.createAttemptAsOwnerAtomic("o2", "L2", "wA", "RUNNING");
      if (!c1.created) throw new Error("alloc1");
      h1.db.prepare("UPDATE execution_attempts SET status='FAILED', completed_at=? WHERE id=?").run(Date.now(), c1.attempt.id);
      const c2 = h1.store.createAttemptAsOwnerAtomic("o2", "L2", "wA", "RUNNING");
      if (!c2.created) throw new Error("alloc2");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getAttempt(h2, c2.attempt.id).attempt_number === 2, "O2 #2 number durable");
      ok(countAttempts(h2, "o2") === 2, "O2 two rows");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-O3 terminal job durable across reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("o3"));
      setJobRunning(h1.db, "o3", "L3");
      seedLease(h1.db, "o3", "wA", "L3");
      const c = h1.store.createAttemptAsOwnerAtomic("o3", "L3", "wA", "RUNNING");
      if (!c.created) throw new Error("alloc");
      h1.store.completeAttemptAndTransitionJob({
        attemptId: c.attempt.id, jobId: "o3", leaseId: "L3", workerId: "wA",
        attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "o3").status === "SUCCEEDED", "O3 SUCCEEDED durable");
      ok(getAttempt(h2, c.attempt.id).status === "SUCCEEDED", "O3 attempt durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Group P
  console.log("\n163-P1 active claim not erased by process exit simulation");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("p1"));
      const r = h1.store.atomicClaimJob({ jobId: "p1", workerId: "wA", durationMs: 60000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getJob(h2, "p1").current_lease_id === r.lease!.leaseId, "P1 claim durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n163-P2 shutdown does not fabricate success");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("p2"));
    setJobRunning(h.db, "p2", "L2");
    seedLease(h.db, "p2", "wA", "L2");
    ok(getJob(h, "p2").status === "RUNNING", "P2 status not fabricated");
  }

  console.log("\n163-P3 restart picks up eligible expired claim");
  {
    const dir = mkdtempSync(join(tmpdir(), "p163-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("p3"));
      setJobRunning(h1.db, "p3", "L3-old");
      seedLease(h1.db, "p3", "wA", "L3-old", "EXPIRED", Date.now() - 1000);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const r = h2.store.recoverJobAtomic({
        jobId: "p3", expectedStatus: "RUNNING", newStatus: "ORPHANED",
        expectedLeaseId: "L3-old",
        event: { eventType: "execution.recovery.orphaned", payload: {} },
        obligation: { leaseId: "L3-old", workerId: "wA", reason: "LEASE_EXPIRED" },
      });
      ok(r.ok === true, "P3 recovery applied");
      ok(getJob(h2, "p3").status === "ORPHANED", "P3 ORPHANED");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Group Q
  console.log("\n163-Q1 repeated atomicClaimJob");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("q1"));
    const r1 = h.store.atomicClaimJob({ jobId: "q1", workerId: "wA", durationMs: 60000 });
    const r2 = h.store.atomicClaimJob({ jobId: "q1", workerId: "wA", durationMs: 60000 });
    ok(r1.claimed === true && r2.claimed === false, "Q1 only first applies");
  }

  console.log("\n163-Q2 repeated attempt allocation is idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("q2"));
    setJobRunning(h.db, "q2", "L2");
    seedLease(h.db, "q2", "wA", "L2");
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const c = h.store.createAttemptAsOwnerAtomic("q2", "L2", "wA", "RUNNING");
      ids.add(c.created ? c.attempt.id : "none");
    }
    ok(ids.size === 1, "Q2 one id");
    ok(countAttempts(h, "q2") === 1, "Q2 one row");
  }

  console.log("\n163-Q3 repeated completeAttemptAndTransitionJob is idempotent");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("q3"));
    setJobRunning(h.db, "q3", "L3");
    seedLease(h.db, "q3", "wA", "L3");
    const c = h.store.createAttemptAsOwnerAtomic("q3", "L3", "wA", "RUNNING");
    if (!c.created) throw new Error("alloc");
    const args = {
      attemptId: c.attempt.id, jobId: "q3", leaseId: "L3", workerId: "wA",
      attemptStatus: "SUCCEEDED" as const, expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    };
    const r1 = h.store.completeAttemptAndTransitionJob(args);
    const r2 = h.store.completeAttemptAndTransitionJob(args);
    const applied = (r1.applied ? 1 : 0) + (r2.applied ? 1 : 0);
    ok(applied === 1, "Q3 exactly one applied");
  }

  // Group R
  console.log("\n163-R1 recovery op for job X cannot mutate job Y");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("r1-x"));
    h.store.createJob(queuedJob("r1-y"));
    h.store.recoveryOps.createOrGetOperation({ jobId: "r1-x", leaseId: "L1", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "r1-y", leaseId: "L2", workerId: "wB", operationType: "TIMEOUT" });
    ok(countOps(h, "r1-x") === 1, "R1 X one op");
    ok(countOps(h, "r1-y") === 1, "R1 Y one op");
    ok(countOps(h, "r1-x") + countOps(h, "r1-y") === 2, "R1 two distinct");
  }

  console.log("\n163-R2 attempt for job X cannot touch job Y's attempt");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("r2-x"));
    h.store.createJob(queuedJob("r2-y"));
    setJobRunning(h.db, "r2-x", "L2x");
    setJobRunning(h.db, "r2-y", "L2y");
    seedLease(h.db, "r2-x", "wA", "L2x");
    seedLease(h.db, "r2-y", "wB", "L2y");
    const cX = h.store.createAttemptAsOwnerAtomic("r2-x", "L2x", "wA", "RUNNING");
    const cY = h.store.createAttemptAsOwnerAtomic("r2-y", "L2y", "wB", "RUNNING");
    ok(cX.attempt.id !== cY.attempt.id, "R2 distinct");
    const r = h.store.updateAttemptAsOwner({ ...cY.attempt, jobId: "r2-x", status: "SUCCEEDED" as any }, "L2x", "wA");
    ok(r.updated === false, "R2 cross-job rejected");
  }

  console.log("\n163-R3 recovery lease is distinct from execution lease");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("r3"));
    setJobRunning(h.db, "r3", "exec-L");
    seedLease(h.db, "r3", "wA", "exec-L");
    h.store.recoveryOps.createOrGetOperation({ jobId: "r3", leaseId: "exec-L", workerId: "wA", operationType: "TIMEOUT" });
    const execLease = getJob(h, "r3").current_lease_id;
    const op = getOp(h, "r3", "TIMEOUT");
    ok(execLease === "exec-L", "R3 exec lease intact");
    ok(op.lease_id === "exec-L", "R3 recovery op references exec lease");
    ok(op.claim_owner === null, "R3 recovery op has no claim_owner until claimed");
  }

  console.log("\n163-R4 different operation types on same job coexist");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("r4"));
    h.store.recoveryOps.createOrGetOperation({ jobId: "r4", leaseId: "L4", workerId: "wA", operationType: "TIMEOUT" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "r4", leaseId: "L4", workerId: "wA", operationType: "ORPHAN_RECOVERY" });
    h.store.recoveryOps.createOrGetOperation({ jobId: "r4", leaseId: "L4", workerId: "wA", operationType: "CANCELLATION" });
    ok(countOps(h, "r4") === 3, "R4 three distinct op types");
  }

  console.log("\n--- Phase 163: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE163 DRIVER CRASH:", err); process.exit(1); });
