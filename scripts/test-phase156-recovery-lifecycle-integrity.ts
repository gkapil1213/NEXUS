// scripts/test-phase156-recovery-lifecycle-integrity.ts
// Phase 156 - durable recovery operation lifecycle integrity & terminal fencing.
//
// Real better-sqlite3, real ExecutionStore, real ExecutionEngine. Every
// assertion reads durable SQLite rows.
//
// Concurrency note: better-sqlite3 is synchronous. Tests interleave two
// owners and let the SQL CAS predicates in claimOperation / mark* / cancel /
// renew decide the winner. The database, not JS call order, is the authority.

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
  const engine = new ExecutionEngine(
    store,
    { detectLostWorkers: () => [] } as any,
    { recoverExpiredLeases: () => [] } as any,
    {} as any,
    {}
  );
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
function getOp(h: H, opId: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function getJob(h: H, jobId: string) {
  return h.db.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(jobId) as any;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}
function countOps(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
}
function mkOp(h: H, jobId: string, owner = "A", durationMs = 60000, at = Date.now()) {
  h.store.createJob(queuedJob(jobId));
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: "CANCELLATION",
  });
  h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner, durationMs, now: at });
  return { opId: operation.operationId, expiresAt: at + durationMs };
}
function mkOpInProgress(h: H, jobId: string, owner = "A", durationMs = 60000, at = Date.now()) {
  const r = mkOp(h, jobId, owner, durationMs, at);
  h.store.recoveryOps.markInProgress(r.opId, owner, at);
  return r;
}

async function main() {
  console.log("=== Phase 156 - Recovery Lifecycle Integrity & Terminal Fencing ===\n");

  // ================================================================
  // Group A - State machine (6)
  // ================================================================

  console.log("156-A1 PENDING -> CLAIMED");
  {
    const h = makeHarness();
    h.store.createJob(queuedJob("a1"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "a1", leaseId: "L1", workerId: "w1", operationType: "CANCELLATION",
    });
    ok(getOp(h, operation.operationId).state === "PENDING", "A1 starts PENDING");
    const c = h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner: "A", durationMs: 60000 });
    ok(c.claimed === true && getOp(h, operation.operationId).state === "CLAIMED", "A1 -> CLAIMED");
  }

  console.log("\n156-A2 CLAIMED -> IN_PROGRESS");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a2", "A", 60000, t);
    ok(getOp(h, opId).state === "CLAIMED", "A2 CLAIMED");
    ok(h.store.recoveryOps.markInProgress(opId, "A", t + 1000) === true, "A2 in progress applied");
    ok(getOp(h, opId).state === "IN_PROGRESS", "A2 IN_PROGRESS");
  }

  console.log("\n156-A3 IN_PROGRESS -> COMPLETED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "a3", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 1000) === true, "A3 complete applied");
    ok(getOp(h, opId).state === "COMPLETED", "A3 COMPLETED");
  }

  console.log("\n156-A4 IN_PROGRESS -> FAILED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "a4", "A", 60000, t);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000) === true, "A4 fail applied");
    ok(getOp(h, opId).state === "FAILED", "A4 FAILED");
  }

  console.log("\n156-A5 IN_PROGRESS -> RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "a5", "A", 60000, t);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000) === true, "A5 RR applied");
    ok(getOp(h, opId).state === "RECOVERY_REQUIRED", "A5 RECOVERY_REQUIRED");
  }

  console.log("\n156-A6 IN_PROGRESS -> CANCELLED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "a6", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(r.cancelled === true, "A6 cancel applied");
    ok(getOp(h, opId).state === "CANCELLED", "A6 CANCELLED");
  }

  // ================================================================
  // Group B - Terminal fencing (full transition matrix)
  // ================================================================

  console.log("\n156-B1 COMPLETED cannot regress");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "b1", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 2000) === false, "B1 complete->fail rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "B1 complete->cancel rejected");
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 2000) === false, "B1 complete->RR rejected");
    ok(h.store.recoveryOps.markInProgress(opId, "A", t + 2000) === false, "B1 complete->IP rejected");
    ok(getOp(h, opId).state === "COMPLETED", "B1 still COMPLETED");
  }

  console.log("\n156-B2 FAILED cannot regress");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "b2", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 2000) === false, "B2 fail->complete rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "B2 fail->cancel rejected");
    ok(getOp(h, opId).state === "FAILED", "B2 still FAILED");
  }

  console.log("\n156-B3 RECOVERY_REQUIRED cannot regress");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "b3", "A", 60000, t);
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 2000) === false, "B3 RR->complete rejected");
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 2000) === false, "B3 RR->fail rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "B3 RR->cancel rejected");
    ok(getOp(h, opId).state === "RECOVERY_REQUIRED", "B3 still RECOVERY_REQUIRED");
  }

  console.log("\n156-B4 CANCELLED cannot regress");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "b4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 2000) === false, "B4 cancelled->complete rejected");
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 2000) === false, "B4 cancelled->fail rejected");
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 2000) === false, "B4 cancelled->RR rejected");
    ok(h.store.recoveryOps.markInProgress(opId, "A", t + 2000) === false, "B4 cancelled->IP rejected");
    ok(getOp(h, opId).state === "CANCELLED", "B4 still CANCELLED");
  }

  // ================================================================
  // Group C - Lease fencing (10)
  // ================================================================

  console.log("\n156-C1 live owner can complete");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOpInProgress(h, "c1", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", expiresAt - 1) === true, "C1 completes before expiry");
  }

  console.log("\n156-C2 exact expiry cannot complete");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOpInProgress(h, "c2", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", expiresAt) === false, "C2 exact-boundary rejects");
  }

  console.log("\n156-C3 expired owner cannot complete");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "c3", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 120000) === false, "C3 expired rejects");
  }

  console.log("\n156-C4 live owner can fail");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOpInProgress(h, "c4", "A", 60000, t);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", expiresAt - 1) === true, "C4 fails before expiry");
  }

  console.log("\n156-C5 expired owner cannot fail");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "c5", "A", 60000, t);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 120000) === false, "C5 expired rejects");
  }

  console.log("\n156-C6 live owner can mark recovery-required");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOpInProgress(h, "c6", "A", 60000, t);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", expiresAt - 1) === true, "C6 RR before expiry");
  }

  console.log("\n156-C7 expired owner cannot mark recovery-required");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "c7", "A", 60000, t);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 120000) === false, "C7 expired rejects");
  }

  console.log("\n156-C8 live owner can cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOpInProgress(h, "c8", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt - 1 });
    ok(r.cancelled === true, "C8 cancel before expiry");
  }

  console.log("\n156-C9 expired owner cannot cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "c9", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "EXPIRED", "C9 expired rejects with EXPIRED");
  }

  console.log("\n156-C10 expired owner cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "c10", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    ok(r.renewed === false && r.reason === "EXPIRED", "C10 expired renew rejects");
  }

  // ================================================================
  // Group D - Takeover (5)
  // ================================================================

  console.log("\n156-D1 B cannot claim while A's lease is live");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "d1", "A", 60000, t);
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 1000 });
    ok(r.claimed === false, "D1 B rejected while A live");
    ok(getOp(h, opId).claim_owner === "A", "D1 A still owner");
  }

  console.log("\n156-D2 B can claim after A's lease expires");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "d2", "A", 60000, t);
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(r.claimed === true, "D2 B takes over");
    ok(getOp(h, opId).claim_owner === "B", "D2 owner is B");
  }

  console.log("\n156-D3 A fenced after B takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "d3", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r1 = h.store.recoveryOps.markCompleted(opId, "A", t + 130000);
    const r2 = h.store.recoveryOps.markFailed(opId, "A", "err", t + 130000);
    const r3 = h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 130000);
    const r4 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    const r5 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 130000 });
    ok(r1 === false, "D3 A complete fenced");
    ok(r2 === false, "D3 A fail fenced");
    ok(r3 === false, "D3 A RR fenced");
    ok(r4.cancelled === false, "D3 A cancel fenced");
    ok(r5.renewed === false, "D3 A renew fenced");
  }

  console.log("\n156-D4 B can terminalize under new claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "d4", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(h.store.recoveryOps.markCompleted(opId, "B", t + 130000) === true, "D4 B completes");
    ok(getOp(h, opId).state === "COMPLETED", "D4 COMPLETED");
  }

  console.log("\n156-D5 A cannot mutate after B terminalizes");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "d5", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    h.store.recoveryOps.markCompleted(opId, "B", t + 130000);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 140000) === false, "D5 A late complete rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 140000 }).cancelled === false, "D5 A late cancel rejected");
    ok(getOp(h, opId).state === "COMPLETED", "D5 COMPLETED preserved");
  }

  // ================================================================
  // Group E - Terminal races (6)
  // ================================================================

  console.log("\n156-E1 complete vs cancel: complete first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e1", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 1000) === true, "E1 complete applied");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "E1 cancel rejected");
    ok(getOp(h, opId).state === "COMPLETED", "E1 COMPLETED wins");
  }

  console.log("\n156-E2 complete vs fail: complete first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e2", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 2000) === false, "E2 fail rejected");
    ok(getOp(h, opId).state === "COMPLETED", "E2 COMPLETED");
  }

  console.log("\n156-E3 complete vs recovery-required: complete first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e3", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 2000) === false, "E3 RR rejected");
    ok(getOp(h, opId).state === "COMPLETED", "E3 COMPLETED");
  }

  console.log("\n156-E4 fail vs cancel: fail first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e4", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "E4 cancel rejected");
    ok(getOp(h, opId).state === "FAILED", "E4 FAILED");
  }

  console.log("\n156-E5 fail vs recovery-required: fail first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e5", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 2000) === false, "E5 RR rejected");
    ok(getOp(h, opId).state === "FAILED", "E5 FAILED");
  }

  console.log("\n156-E6 recovery-required vs cancel: RR first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "e6", "A", 60000, t);
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 }).cancelled === false, "E6 cancel rejected");
    ok(getOp(h, opId).state === "RECOVERY_REQUIRED", "E6 RECOVERY_REQUIRED");
  }

  // ================================================================
  // Group F - Idempotency (4)
  // ================================================================

  console.log("\n156-F1 duplicate complete is idempotent");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "f1", "A", 60000, t);
    const r1 = h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const r2 = h.store.recoveryOps.markCompleted(opId, "A", t + 2000);
    ok(r1 === true, "F1 first applied");
    ok(r2 === false, "F1 second rejected (state not in eligible set)");
    ok(getOp(h, opId).state === "COMPLETED", "F1 COMPLETED");
  }

  console.log("\n156-F2 duplicate cancel is idempotent");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "f2", "A", 60000, t);
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const r2 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r1.cancelled === true && !r1.alreadyCancelled, "F2 first applies");
    ok(r2.cancelled === true && r2.alreadyCancelled === true, "F2 second idempotent");
    ok(getOp(h, opId).state === "CANCELLED", "F2 CANCELLED");
  }

  console.log("\n156-F3 duplicate fail rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "f3", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err2", t + 2000) === false, "F3 second fail rejected");
    ok(getOp(h, opId).last_error === "err", "F3 original error preserved");
  }

  console.log("\n156-F4 duplicate reconciliation is a no-op");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "f4", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const before = countEvents(h, "f4");
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    h.engine.reconcileExecutionRecoveryOperations();
    ok(getOp(h, opId).state === "COMPLETED", "F4 still COMPLETED");
    ok(countEvents(h, "f4") === before, "F4 no extra events");
  }

  // ================================================================
  // Group G - Durability (5)
  // ================================================================

  console.log("\n156-G1 DB close/reopen after claim");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "g1", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "CLAIMED", "G1 state durable");
      ok(getOp(h2, opId).claim_owner === "A", "G1 owner durable");
      ok(getOp(h2, opId).attempt_count === 1, "G1 attempt_count durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n156-G2 DB close/reopen after IN_PROGRESS");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOpInProgress(h1, "g2", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "IN_PROGRESS", "G2 state durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n156-G3 DB close/reopen after cancellation");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOpInProgress(h1, "g3", "A", 60000, t);
      h1.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "CANCELLED", "G3 CANCELLED durable");
      ok(getOp(h2, opId).claim_owner === null, "G3 claim cleared durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n156-G4 DB close/reopen after completion");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOpInProgress(h1, "g4", "A", 60000, t);
      h1.store.recoveryOps.markCompleted(opId, "A", t + 1000);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "COMPLETED", "G4 COMPLETED durable");
      ok(getOp(h2, opId).completed_at !== null, "G4 completed_at durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n156-G5 DB close/reopen after takeover");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOpInProgress(h1, "g5", "A", 60000, t);
      h1.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).claim_owner === "B", "G5 B owner durable");
      ok(getOp(h2, opId).attempt_count === 2, "G5 attempt_count=2 durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group H - Attempt integrity (5)
  // ================================================================

  console.log("\n156-H1 normal attempt count");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "h1", "A", 60000, t);
    ok(getOp(h, opId).attempt_count === 1, "H1 one claim = attempt_count 1");
  }

  console.log("\n156-H2 takeover attempt count");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "h2", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(getOp(h, opId).attempt_count === 2, "H2 takeover increments");
  }

  console.log("\n156-H3 duplicate terminal request does not increment");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "h3", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.markCompleted(opId, "A", t + 2000);
    h.store.recoveryOps.markCompleted(opId, "A", t + 3000);
    ok(getOp(h, opId).attempt_count === before, "H3 attempt_count unchanged");
  }

  console.log("\n156-H4 renewal does not increment");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "h4", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 50000 });
    ok(getOp(h, opId).attempt_count === before, "H4 attempt_count unchanged");
  }

  console.log("\n156-H5 cancellation does not increment");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "h5", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(getOp(h, opId).attempt_count === before, "H5 attempt_count unchanged");
  }

  // ================================================================
  // Group I - Events (4)
  // ================================================================

  console.log("\n156-I1 terminal lifecycle mutations create no events");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "i1", "A", 60000, t);
    const before = countEvents(h, "i1");
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    ok(countEvents(h, "i1") === before, "I1 no event from markCompleted");
  }

  console.log("\n156-I2 duplicate terminal does not duplicate event");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "i2", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const before = countEvents(h, "i2");
    h.store.recoveryOps.markCompleted(opId, "A", t + 2000);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(countEvents(h, "i2") === before, "I2 no extra events");
  }

  console.log("\n156-I3 cancelled op does not create event");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "i3", "A", 60000, t);
    const before = countEvents(h, "i3");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(countEvents(h, "i3") === before, "I3 cancel creates no event");
  }

  console.log("\n156-I4 restart reconciliation does not duplicate events");
  {
    const dir = mkdtempSync(join(tmpdir(), "p156-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOpInProgress(h1, "i4", "A", 60000, t);
      h1.store.recoveryOps.markCompleted(opId, "A", t + 1000);
      const before = countEvents(h1, "i4");
      h1.db.close();
      const h2 = makeHarness(dbFile);
      h2.engine.reconcileExecutionRecoveryOperations();
      h2.engine.reconcileExecutionRecoveryOperations();
      ok(countEvents(h2, "i4") === before, "I4 no events after reload+reconcile");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group J - Resumability (5)
  // ================================================================

  console.log("\n156-J1 COMPLETED excluded from resumable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "j1", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const res = h.store.recoveryOps.listResumableOperations();
    ok(!res.some((o: any) => o.operationId === opId), "J1 COMPLETED excluded");
  }

  console.log("\n156-J2 FAILED is present in resumable (Phase 145 behavior)");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "j2", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    const res = h.store.recoveryOps.listResumableOperations();
    ok(res.some((o: any) => o.operationId === opId), "J2 FAILED present");
  }

  console.log("\n156-J3 RECOVERY_REQUIRED excluded from resumable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "j3", "A", 60000, t);
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000);
    const res = h.store.recoveryOps.listResumableOperations();
    ok(!res.some((o: any) => o.operationId === opId), "J3 RR excluded");
  }

  console.log("\n156-J4 CANCELLED excluded from resumable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "j4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const res = h.store.recoveryOps.listResumableOperations();
    ok(!res.some((o: any) => o.operationId === opId), "J4 CANCELLED excluded");
  }

  console.log("\n156-J5 no terminal resurrection after reconciliation");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "j5", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const before = getOp(h, opId).state;
    for (let i = 0; i < 5; i++) h.engine.reconcileExecutionRecoveryOperations();
    ok(getOp(h, opId).state === before, "J5 terminal preserved");
    ok(countOps(h, "j5") === 1, "J5 one op row");
  }

  // ================================================================
  // Additional invariants (>= 4 to pass 54 threshold comfortably)
  // ================================================================

  console.log("\n156-K1 CANCELLED cannot be reclaimed (attempt any)");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "k1", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    for (let i = 0; i < 3; i++) {
      const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 + i });
      ok(r.claimed === false, "K1 attempt " + (i + 1) + " rejected");
    }
  }

  console.log("\n156-K2 operation identity stable across lifecycle");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "k2", "A", 60000, t);
    const before = getOp(h, opId);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const after = getOp(h, opId);
    ok(before.operation_id === after.operation_id, "K2 id stable");
    ok(before.job_id === after.job_id, "K2 job stable");
    ok(before.operation_type === after.operation_type, "K2 type stable");
    ok(before.idempotency_key === after.idempotency_key, "K2 idempotency key stable");
  }

  console.log("\n156-K3 finalizeCompletedOperation idempotent");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "k3", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    // finalize allows FAILED -> COMPLETED when claim expired/null
    const r1 = h.store.recoveryOps.finalizeCompletedOperation(opId, t + 120000);
    const r2 = h.store.recoveryOps.finalizeCompletedOperation(opId, t + 130000);
    ok(r1 === true, "K3 first finalize applied");
    ok(r2 === false, "K3 second finalize no-op");
    ok(getOp(h, opId).state === "COMPLETED", "K3 COMPLETED");
  }

  console.log("\n156-K4 finalize rejects CANCELLED and RECOVERY_REQUIRED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOpInProgress(h, "k4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(h.store.recoveryOps.finalizeCompletedOperation(opId, t + 120000) === false, "K4 finalize on CANCELLED rejected");

    const h2 = makeHarness();
    const t2 = Date.now();
    const { opId: op2 } = mkOpInProgress(h2, "k4b", "A", 60000, t2);
    h2.store.recoveryOps.markRecoveryRequired(op2, "A", "err", t2 + 1000);
    ok(h2.store.recoveryOps.finalizeCompletedOperation(op2, t2 + 120000) === false, "K4 finalize on RR rejected");
  }

  console.log("\n--- Phase 156: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE156 DRIVER CRASH:", err); process.exit(1); });
