// scripts/test-phase154-recovery-cancellation-shutdown.ts
// Phase 154 - durable recovery cancellation & worker shutdown safety.
//
// Real better-sqlite3, real ExecutionStore, real ExecutionEngine. Every
// assertion reads durable SQLite rows.

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
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES (?,?,?,?,?,?)"
  ).run(leaseId, jobId, workerId, Date.now() - 120000, expiresAt, status);
}
function setJobRunning(db: Database.Database, jobId: string, leaseId: string | null): void {
  db.prepare("UPDATE execution_jobs SET status='RUNNING', current_lease_id=? WHERE id=?").run(leaseId, jobId);
}
function getOp(h: H, opId: string) { return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any; }
function getJob(h: H, jobId: string) { return h.db.prepare("SELECT status, current_lease_id FROM execution_jobs WHERE id = ?").get(jobId) as any; }
function countOps(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}
function countObligations(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_ownership_obligations WHERE job_id = ?").get(jobId) as any).n;
}
function createClaimedOp(h: H, jobId: string, owner = "A", type = "CANCELLATION", t0 = Date.now()): string {
  h.store.createJob(queuedJob(jobId));
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: type as any,
  });
  h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner, durationMs: 60000, now: t0 });
  return operation.operationId;
}

async function main() {
  console.log("=== Phase 154 - Recovery Cancellation & Shutdown Safety ===\n");

  // ================================================================
  // Group A - Cancellation basics
  // ================================================================

  console.log("154-A1 owner can cancel its own active operation");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a1");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === true, "A1 cancelled");
    ok(getOp(h, opId).state === "CANCELLED", "A1 durable CANCELLED");
    ok(getOp(h, opId).claim_owner === null, "A1 claim cleared");
  }

  console.log("\n154-A2 non-owner cannot cancel active operation");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a2", "A");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B" });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "A2 B rejected");
    ok(getOp(h, opId).state === "CLAIMED", "A2 state preserved");
    ok(getOp(h, opId).claim_owner === "A", "A2 owner preserved");
  }

  console.log("\n154-A3 missing operation returns NOT_FOUND");
  {
    const h = makeHarness();
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: "does-not-exist", owner: "A" });
    ok(r.cancelled === false && r.reason === "NOT_FOUND", "A3 NOT_FOUND");
  }

  console.log("\n154-A4 completed operation cannot be cancelled");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a4", "A");
    h.store.recoveryOps.markCompleted(opId, "A");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "A4 rejected");
    ok(getOp(h, opId).state === "COMPLETED", "A4 COMPLETED preserved");
  }

  console.log("\n154-A5 failed operation cannot be cancelled");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a5", "A");
    h.store.recoveryOps.markFailed(opId, "A", "err");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "A5 rejected");
  }

  console.log("\n154-A6 recovery-required operation cannot be cancelled");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a6", "A");
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "A6 rejected");
  }

  console.log("\n154-A7 repeated cancellation is idempotent");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "a7", "A");
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r2 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r3 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r1.cancelled === true && !r1.alreadyCancelled, "A7 first cancels");
    ok(r2.cancelled === true && r2.alreadyCancelled === true, "A7 second idempotent");
    ok(r3.cancelled === true && r3.alreadyCancelled === true, "A7 third idempotent");
    ok(getOp(h, opId).state === "CANCELLED", "A7 durable CANCELLED");
  }

  // ================================================================
  // Group B - Ownership fencing
  // ================================================================

  console.log("\n154-B1 live owner retains authority after cancel attempt by B");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b1", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B" });
    ok(h.store.recoveryOps.markCompleted(opId, "A") === true, "B1 A can still complete");
    ok(getOp(h, opId).state === "COMPLETED", "B1 COMPLETED");
  }

  console.log("\n154-B2 expired owner cannot renew, cannot cancel after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b2", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    const rA = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t0 + 130000 });
    ok(rA.cancelled === false && rA.reason === "OWNERSHIP_LOST", "B2 A fenced");
    ok(getOp(h, opId).claim_owner === "B", "B2 owner is B");
  }

  console.log("\n154-B3 stale owner cannot complete after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b3", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    ok(h.store.recoveryOps.markCompleted(opId, "A", t0 + 130000) === false, "B3 A rejected");
    ok(h.store.recoveryOps.markCompleted(opId, "B", t0 + 130000) === true, "B3 B succeeds");
  }

  console.log("\n154-B4 stale owner cannot fail after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b4", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t0 + 130000) === false, "B4 A rejected");
  }

  console.log("\n154-B5 stale owner cannot renew after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b5", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 130000 });
    ok(r.renewed === false && r.reason === "OWNERSHIP_LOST", "B5 A renew rejected");
  }

  console.log("\n154-B6 new owner can cancel after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b6", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t0 + 130000 });
    ok(r.cancelled === true, "B6 B cancels");
    ok(getOp(h, opId).state === "CANCELLED", "B6 CANCELLED");
  }

  console.log("\n154-B7 claim expiry alone does not permit cancel without ownership");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b7", "A");
    // A's claim expires; A has not been taken over yet. A cancels. Should succeed.
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: (Date.now() + 120000) });
    ok(r.cancelled === true, "B7 A can cancel expired-own claim");
  }

  console.log("\n154-B8 non-owner cannot cancel already-expired claim");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "b8", "A");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: (Date.now() + 120000) });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "B8 B rejected");
  }

  // ================================================================
  // Group C - Cancellation races
  // ================================================================

  console.log("\n154-C1 cancellation vs completion: completion wins if it commits first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c1", "A");
    h.store.recoveryOps.markCompleted(opId, "A");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "C1 cancel loses");
    ok(getOp(h, opId).state === "COMPLETED", "C1 COMPLETED durable");
  }

  console.log("\n154-C2 cancellation vs completion: cancel wins if it commits first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c2", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(h.store.recoveryOps.markCompleted(opId, "A") === false, "C2 late complete rejected");
    ok(getOp(h, opId).state === "CANCELLED", "C2 CANCELLED durable");
  }

  console.log("\n154-C3 cancellation vs failure: failure first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c3", "A");
    h.store.recoveryOps.markFailed(opId, "A", "err");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "C3 cancel loses");
    ok(getOp(h, opId).state === "FAILED", "C3 FAILED durable");
  }

  console.log("\n154-C4 cancellation vs failure: cancel first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c4", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(h.store.recoveryOps.markFailed(opId, "A", "late") === false, "C4 late fail rejected");
    ok(getOp(h, opId).state === "CANCELLED", "C4 CANCELLED durable");
  }

  console.log("\n154-C5 cancellation vs recovery-required: recovery-required first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c5", "A");
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r.cancelled === false && r.reason === "TERMINAL", "C5 cancel loses");
    ok(getOp(h, opId).state === "RECOVERY_REQUIRED", "C5 preserved");
  }

  console.log("\n154-C6 cancellation vs recovery-required: cancel first");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c6", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "late") === false, "C6 late RR rejected");
    ok(getOp(h, opId).state === "CANCELLED", "C6 CANCELLED durable");
  }

  console.log("\n154-C7 repeated reconciliation after cancellation is a no-op");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "c7", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const before = countOps(h, "c7");
    const beforeEvents = countEvents(h, "c7");
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(countOps(h, "c7") === before, "C7 op count unchanged");
    ok(countEvents(h, "c7") === beforeEvents, "C7 event count unchanged");
    ok(getOp(h, opId).state === "CANCELLED", "C7 still CANCELLED");
  }

  // ================================================================
  // Group D - Shutdown
  // ================================================================

  console.log("\n154-D1 graceful shutdown stops new claims");
  {
    const h = makeHarness();
    h.engine.shutdown();
    ok(h.engine.isShuttingDown() === true, "D1 flag set");
    // Seed a job with an expired lease; without the flag, recoverStaleJobs
    // would process it. With the flag, it must be a no-op.
    h.store.createJob(queuedJob("d1"));
    setJobRunning(h.db, "d1", "L1");
    seedLease(h.db, "d1", "w1", "L1", "EXPIRED", Date.now() - 1000);
    (h.engine as any).leaseManager = { recoverExpiredLeases: () => [{ jobId: "d1", leaseId: "L1", workerId: "w1", expiresAt: Date.now() - 1000 }] };
    h.engine.recoverStaleJobs();
    ok(getJob(h, "d1").status === "RUNNING", "D1 job untouched after shutdown");
  }

  console.log("\n154-D2 existing claim remains safely durable after shutdown");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d2", "A");
    h.engine.shutdown();
    const op = getOp(h, opId);
    ok(op.state === "CLAIMED", "D2 still CLAIMED");
    ok(op.claim_owner === "A", "D2 owner preserved");
    ok(op.claim_expires_at !== null, "D2 expiry preserved");
  }

  console.log("\n154-D3 shutdown does not corrupt active operation");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d3", "A");
    h.store.recoveryOps.markInProgress(opId, "A");
    h.engine.shutdown();
    ok(getOp(h, opId).state === "IN_PROGRESS", "D3 state preserved");
  }

  console.log("\n154-D4 shutdown does not consume retry budget");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d4", "A");
    const before = getOp(h, opId).attempt_count;
    h.engine.shutdown();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.recoverStaleJobs();
    ok(getOp(h, opId).attempt_count === before, "D4 attempt_count unchanged");
  }

  console.log("\n154-D5 worker restart can recover operation after lease expiry");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d5", "A");
    // Simulate A's shutdown and later lease expiry, then B takes over.
    h.engine.shutdown();
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: (Date.now() + 120000) });
    ok(r.claimed === true, "D5 B takes over");
    ok(h.store.recoveryOps.markCompleted(opId, "B", (Date.now() + 120000)) === true, "D5 B completes");
  }

  console.log("\n154-D6 shutdown followed by lease expiry permits takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d6", "A");
    const t0 = Date.now();
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    ok(r.claimed === true, "D6 takeover after expiry");
    ok(getOp(h, opId).attempt_count === 2, "D6 two attempts recorded");
  }

  console.log("\n154-D7 stale shutdown worker remains fenced");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "d7", "A");
    h.engine.shutdown();
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t0 + 130000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "D7 A fenced");
  }

  // ================================================================
  // Group E - Crash / restart
  // ================================================================

  console.log("\n154-E1 crash after claim: op is durable, reclaimable after expiry");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "e1", "A");
    const t0 = Date.now();
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    ok(r.claimed === true, "E1 B takes over");
    ok(getOp(h, opId).claim_owner === "B", "E1 owner is B");
  }

  console.log("\n154-E2 crash after IN_PROGRESS: op durable");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "e2", "A");
    h.store.recoveryOps.markInProgress(opId, "A");
    const t0 = Date.now();
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    ok(r.claimed === true, "E2 takeover");
    ok(getOp(h, opId).state === "CLAIMED", "E2 state now CLAIMED by B");
  }

  console.log("\n154-E3 DB close/reopen preserves cancellation state");
  {
    const dir = mkdtempSync(join(tmpdir(), "p154-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const opId = createClaimedOp(h1, "e3", "A");
      h1.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "CANCELLED", "E3 CANCELLED durable");
      ok(getOp(h2, opId).claim_owner === null, "E3 claim cleared durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n154-E4 DB close/reopen preserves claim state");
  {
    const dir = mkdtempSync(join(tmpdir(), "p154-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const opId = createClaimedOp(h1, "e4", "A");
      h1.store.recoveryOps.markInProgress(opId, "A");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      const op = getOp(h2, opId);
      ok(op.state === "IN_PROGRESS", "E4 state durable");
      ok(op.claim_owner === "A", "E4 owner durable");
      ok(op.attempt_count === 1, "E4 attempt_count durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n154-E5 restart reconciliation leaves cancelled op alone");
  {
    const dir = mkdtempSync(join(tmpdir(), "p154-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      h1.store.createJob(queuedJob("e5"));
      setJobRunning(h1.db, "e5", "L5");
      seedLease(h1.db, "e5", "w5", "L5");
      const { operation } = h1.store.recoveryOps.createOrGetOperation({
        jobId: "e5", leaseId: "L5", workerId: "w5", operationType: "ORPHAN_RECOVERY",
      });
      h1.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
      h1.store.recoveryOps.cancelOperationClaim({ operationId: operation.operationId, owner: "A" });
      const beforeEvents = countEvents(h1, "e5");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      h2.engine.reconcileExecutionRecoveryOperations();
      h2.engine.reconcileExecutionRecoveryOperations();
      ok(getOp(h2, operation.operationId).state === "CANCELLED", "E5 still CANCELLED");
      ok(countEvents(h2, "e5") === beforeEvents, "E5 no new events");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n154-E6 cancelled op does not appear in listResumableOperations");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "e6", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const resumable = h.store.recoveryOps.listResumableOperations();
    ok(!resumable.some((o: any) => o.operationId === opId), "E6 not in resumable list");
  }

  console.log("\n154-E7 cancelled op does not consume retry budget");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "e7", "A");
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(getOp(h, opId).attempt_count === before, "E7 attempt_count unchanged");
  }

  // ================================================================
  // Group F - Concurrency
  // ================================================================

  console.log("\n154-F1 two workers cannot simultaneously own one operation");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f1", "A");
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000 });
    ok(r.claimed === false, "F1 B rejected");
    ok(getOp(h, opId).claim_owner === "A", "F1 A still owner");
  }

  console.log("\n154-F2 cancellation vs completion has one authoritative winner");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f2", "A");
    const cancelResult = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const completeResult = h.store.recoveryOps.markCompleted(opId, "A");
    const applied = (cancelResult.cancelled ? 1 : 0) + (completeResult ? 1 : 0);
    ok(applied === 1, "F2 exactly one applied");
    const final = getOp(h, opId).state;
    ok(final === "CANCELLED" || final === "COMPLETED", "F2 one terminal state");
  }

  console.log("\n154-F3 cancellation vs failure has one authoritative winner");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f3", "A");
    const cancelResult = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const failResult = h.store.recoveryOps.markFailed(opId, "A", "err");
    const applied = (cancelResult.cancelled ? 1 : 0) + (failResult ? 1 : 0);
    ok(applied === 1, "F3 exactly one applied");
  }

  console.log("\n154-F4 renewal vs cancel: one wins");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f4", "A");
    const renewResult = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    const cancelResult = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(renewResult.renewed === true, "F4 renew ok");
    ok(cancelResult.cancelled === true, "F4 cancel ok after renew");
    ok(getOp(h, opId).state === "CANCELLED", "F4 final CANCELLED");
  }

  console.log("\n154-F5 cancel vs renew: one wins");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f5", "A");
    const cancelResult = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const renewResult = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(cancelResult.cancelled === true, "F5 cancel ok");
    ok(renewResult.renewed === false && renewResult.reason === "TERMINAL", "F5 renew rejected");
  }

  console.log("\n154-F6 duplicate cancellations converge on one terminal");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f6", "A");
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r2 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r3 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    ok(r1.cancelled && !r1.alreadyCancelled, "F6 first applies");
    ok(r2.alreadyCancelled === true && r3.alreadyCancelled === true, "F6 replays idempotent");
    ok(countOps(h, "f6") === 1, "F6 still one op row");
  }

  console.log("\n154-F7 retry budget correct under cancel race");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f7", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    h.store.recoveryOps.markCompleted(opId, "A");
    h.store.recoveryOps.markFailed(opId, "A", "late");
    ok(getOp(h, opId).attempt_count === 1, "F7 attempt_count=1");
  }

  console.log("\n154-F8 stale worker cannot mutate after takeover");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "f8", "A");
    const t0 = Date.now();
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t0 + 120000 });
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t0 + 130000 });
    const r2 = h.store.recoveryOps.markCompleted(opId, "A", t0 + 130000);
    const r3 = h.store.recoveryOps.markFailed(opId, "A", "err", t0 + 130000);
    const r4 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t0 + 130000 });
    ok(r1.cancelled === false, "F8 A cancel rejected");
    ok(r2 === false, "F8 A complete rejected");
    ok(r3 === false, "F8 A fail rejected");
    ok(r4.renewed === false, "F8 A renew rejected");
  }

  // ================================================================
  // Group G - Regression / integrity
  // ================================================================

  console.log("\n154-G1 terminal operations never resurrect");
  {
    const h = makeHarness();
    for (const term of ["COMPLETED", "FAILED", "RECOVERY_REQUIRED"]) {
      const opId = createClaimedOp(h, "g1-" + term, "A");
      if (term === "COMPLETED") h.store.recoveryOps.markCompleted(opId, "A");
      if (term === "FAILED") h.store.recoveryOps.markFailed(opId, "A", "err");
      if (term === "RECOVERY_REQUIRED") h.store.recoveryOps.markRecoveryRequired(opId, "A", "err");
      const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
      const r2 = h.store.recoveryOps.markCompleted(opId, "A");
      const r3 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
      ok(r1.cancelled === false, "G1 " + term + " cancel rejected");
      ok(r2 === false, "G1 " + term + " complete rejected");
      ok(r3.renewed === false, "G1 " + term + " renew rejected");
    }
  }

  console.log("\n154-G2 recovery-required remains durable across reload");
  {
    const dir = mkdtempSync(join(tmpdir(), "p154-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const opId = createClaimedOp(h1, "g2", "A");
      h1.store.recoveryOps.markRecoveryRequired(opId, "A", "err");
      h1.db.close();

      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "RECOVERY_REQUIRED", "G2 durable");
      ok(getOp(h2, opId).last_error === "err", "G2 error durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n154-G3 operation identity remains stable across cancel");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "g3", "A");
    const before = getOp(h, opId);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const after = getOp(h, opId);
    ok(before.operation_id === after.operation_id, "G3 id stable");
    ok(before.job_id === after.job_id, "G3 job stable");
    ok(before.operation_type === after.operation_type, "G3 type stable");
    ok(before.idempotency_key === after.idempotency_key, "G3 idempotency key stable");
  }

  console.log("\n154-G4 attempt count preserved through cancel lifecycle");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "g4", "A");
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    h.store.recoveryOps.markCompleted(opId, "A");
    h.store.recoveryOps.markFailed(opId, "A", "late");
    ok(getOp(h, opId).attempt_count === before, "G4 stable");
  }

  console.log("\n154-G5 Phase 152 concurrency: CANCELLED does not appear in claim eligible states");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "g5", "A");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000 });
    ok(r.claimed === false, "G5 CANCELLED not reclaimable");
  }

  console.log("\n154-G6 Phase 153 lease fencing: cancel does not break renewal semantics");
  {
    const h = makeHarness();
    const opId = createClaimedOp(h, "g6", "A");
    const r1 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r1.renewed === true, "G6 renew works");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A" });
    const r2 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000 });
    ok(r2.renewed === false && r2.reason === "TERMINAL", "G6 renew rejected after cancel");
  }

  console.log("\n--- Phase 154: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE154 DRIVER CRASH:", err); process.exit(1); });
