// scripts/test-phase158-recovery-worker-heartbeat-lease.ts
// Phase 158 - recovery worker lease ownership for long-running operations.
//
// Scope note (Step 0 / Step 11 Group I):
//   The current recovery execution path is synchronous: every recovery body
//   is `body: () => { ... }` with no await, no timer, no long-running work.
//   There is no production caller that needs mid-execution lease renewal today.
//   What exists is the low-level primitive `renewOperationClaim` (Phase 153)
//   and the fencing it enforces. Phase 158 proves that primitive delivers
//   the ownership semantics required for a hypothetical long-running worker,
//   and documents that no production integration is required at this time.
//
// Concurrency note:
//   better-sqlite3 is synchronous. Tests interleave owners deterministically
//   and rely on the SQL CAS predicates in claimOperation / renewOperationClaim
//   / mark* / cancelOperationClaim to decide the winner. The DB, not JS
//   call order, is authoritative.

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
function countOps(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
}
function countEvents(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = ?").get(jobId) as any).n;
}
function mkOp(h: H, jobId: string, owner = "A", durationMs = 60000, at = Date.now()) {
  h.store.createJob(queuedJob(jobId));
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: "CANCELLATION",
  });
  h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner, durationMs, now: at });
  return { opId: operation.operationId, expiresAt: at + durationMs };
}

async function main() {
  console.log("=== Phase 158 - Recovery Worker Lease Ownership ===\n");

  // ================================================================
  // Group A — Basic renewal (5)
  // ================================================================

  console.log("158-A1 first claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a1", "A", 60000, t);
    const op = getOp(h, opId);
    ok(op.state === "CLAIMED", "A1 state CLAIMED");
    ok(op.claim_owner === "A", "A1 owner A");
    ok(op.claim_expires_at === t + 60000, "A1 expiry set");
    ok(op.attempt_count === 1, "A1 attempt_count 1");
  }

  console.log("\n158-A2 live claim renewal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a2", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    ok(r.renewed === true, "A2 renewed true");
  }

  console.log("\n158-A3 expiry extended");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a3", "A", 60000, t);
    const before = getOp(h, opId).claim_expires_at;
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    const after = getOp(h, opId).claim_expires_at;
    ok(after > before, "A3 expiry extended");
    ok(after === t + 30000 + 60000, "A3 expiry = now + duration");
  }

  console.log("\n158-A4 operation identity unchanged across renewal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a4", "A", 60000, t);
    const before = getOp(h, opId);
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    const after = getOp(h, opId);
    ok(before.operation_id === after.operation_id, "A4 id stable");
    ok(before.job_id === after.job_id, "A4 job stable");
    ok(before.operation_type === after.operation_type, "A4 type stable");
    ok(before.idempotency_key === after.idempotency_key, "A4 key stable");
  }

  console.log("\n158-A5 attempt_count unchanged across renewal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a5", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    for (let i = 1; i <= 5; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 10000 * i });
    }
    ok(getOp(h, opId).attempt_count === before, "A5 attempt_count unchanged");
  }

  // ================================================================
  // Group B — Ownership fencing (5)
  // ================================================================

  console.log("\n158-B1 owner can renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b1", "A", 60000, t);
    ok(h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 1000 }).renewed === true, "B1 owner renews");
  }

  console.log("\n158-B2 non-owner cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b2", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "B", durationMs: 60000, now: t + 1000 });
    ok(r.renewed === false, "B2 B rejected");
    ok(r.reason === "OWNERSHIP_LOST", "B2 reason OWNERSHIP_LOST");
  }

  console.log("\n158-B3 expired owner cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b3", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    ok(r.renewed === false, "B3 rejected");
    ok(r.reason === "EXPIRED", "B3 reason EXPIRED");
  }

  console.log("\n158-B4 exact expiry cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "b4", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: expiresAt });
    ok(r.renewed === false && r.reason === "EXPIRED", "B4 exact-boundary rejected");
  }

  console.log("\n158-B5 stale owner cannot mutate any state");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b5", "A", 60000, t);
    const late = t + 120000;
    ok(h.store.recoveryOps.markInProgress(opId, "A", late) === false, "B5 stale markInProgress rejected");
    ok(h.store.recoveryOps.markCompleted(opId, "A", late) === false, "B5 stale markCompleted rejected");
    ok(h.store.recoveryOps.markFailed(opId, "A", "e", late) === false, "B5 stale markFailed rejected");
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "e", late) === false, "B5 stale markRecoveryRequired rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: late }).cancelled === false, "B5 stale cancel rejected");
  }

  // ================================================================
  // Group C — Takeover (4)
  // ================================================================

  console.log("\n158-C1 takeover blocked while renewed claim is live");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c1", "A", 60000, t);
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 55000 });
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 60000 });
    ok(r.claimed === false, "C1 B rejected while A live");
    ok(getOp(h, opId).claim_owner === "A", "C1 owner still A");
  }

  console.log("\n158-C2 takeover succeeds after expiry");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c2", "A", 60000, t);
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(r.claimed === true, "C2 B takes over");
    ok(getOp(h, opId).claim_owner === "B", "C2 owner is B");
  }

  console.log("\n158-C3 new owner becomes authoritative");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c3", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "B", durationMs: 60000, now: t + 130000 }).renewed === true, "C3 B renews");
    ok(h.store.recoveryOps.markCompleted(opId, "B", t + 131000) === true, "C3 B completes");
  }

  console.log("\n158-C4 old owner fenced after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c4", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const late = t + 130000;
    ok(h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: late }).renewed === false, "C4 A renew rejected");
    ok(h.store.recoveryOps.markCompleted(opId, "A", late) === false, "C4 A complete rejected");
    ok(h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: late }).cancelled === false, "C4 A cancel rejected");
  }

  // ================================================================
  // Group D — Concurrent races (6)
  // ================================================================

  console.log("\n158-D1 renewal vs takeover: renewal first keeps A authoritative");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d1", "A", 60000, t);
    // A renews just before expiry.
    const renew = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 59000 });
    ok(renew.renewed === true, "D1 A renewed");
    // B attempts takeover at the original expiry instant — must be rejected.
    const b = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 60000 });
    ok(b.claimed === false, "D1 B rejected");
    ok(getOp(h, opId).claim_owner === "A", "D1 A still owner");
  }

  console.log("\n158-D2 renewal vs completion");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d2", "A", 60000, t);
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 31000) === true, "D2 complete after renew works");
    ok(getOp(h, opId).state === "COMPLETED", "D2 COMPLETED");
    const renew = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 32000 });
    ok(renew.renewed === false && renew.reason === "TERMINAL", "D2 renew after complete rejected");
  }

  console.log("\n158-D3 renewal vs failure");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d3", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "D3 renew after fail rejected");
  }

  console.log("\n158-D4 renewal vs cancellation");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "D4 renew after cancel rejected");
  }

  console.log("\n158-D5 stale owner vs new owner mutation");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d5", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    // Interleave stale A and live B.
    const aDone = h.store.recoveryOps.markCompleted(opId, "A", t + 121000);
    const bDone = h.store.recoveryOps.markCompleted(opId, "B", t + 122000);
    ok(aDone === false, "D5 A rejected");
    ok(bDone === true, "D5 B applied");
    ok(getOp(h, opId).state === "COMPLETED", "D5 COMPLETED");
  }

  console.log("\n158-D6 renewal vs shutdown flag");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d6", "A", 60000, t);
    // Shutdown does not touch durable claim state.
    h.engine.shutdown();
    const op = getOp(h, opId);
    ok(op.state === "CLAIMED", "D6 state preserved");
    ok(op.claim_owner === "A", "D6 owner preserved");
    // Renewal still succeeds at the store level, because the store is authoritative.
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 1000 });
    ok(r.renewed === true, "D6 renewal not blocked by shutdown flag");
    ok(h.engine.isShuttingDown() === true, "D6 flag observed");
  }

  // ================================================================
  // Group E — Restart (4)
  // ================================================================

  console.log("\n158-E1 claim survives DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p158-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId, expiresAt } = mkOp(h1, "e1", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const op = getOp(h2, opId);
      ok(op.state === "CLAIMED", "E1 state durable");
      ok(op.claim_owner === "A", "E1 owner durable");
      ok(op.claim_expires_at === expiresAt, "E1 expiry durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n158-E2 renewal survives DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p158-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "e2", "A", 60000, t);
      h1.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
      const expectedExpiry = t + 90000;
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).claim_expires_at === expectedExpiry, "E2 renewed expiry durable");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n158-E3 expiry survives DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p158-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "e3", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      // Renewal at t+120000 must still be rejected: the expiry in DB is t+60000.
      const r = h2.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
      ok(r.renewed === false && r.reason === "EXPIRED", "E3 expired after reopen");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n158-E4 takeover after expiry survives DB reopen");
  {
    const dir = mkdtempSync(join(tmpdir(), "p158-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "e4", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const r = h2.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
      ok(r.claimed === true, "E4 B takes over after reopen");
      ok(getOp(h2, opId).claim_owner === "B", "E4 owner durable B");
      ok(getOp(h2, opId).attempt_count === 2, "E4 attempt_count 2");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ================================================================
  // Group F — Retry integrity (4)
  // ================================================================

  console.log("\n158-F1 renewal does not increment attempt_count");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f1", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    for (let i = 1; i <= 10; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 3000 * i });
    }
    ok(getOp(h, opId).attempt_count === before, "F1 attempt_count unchanged across 10 renewals");
  }

  console.log("\n158-F2 renewal does not consume retry budget (job row untouched)");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f2", "A", 60000, t);
    const before = h.db.prepare("SELECT retry_policy, next_attempt_at FROM execution_jobs WHERE id = 'f2'").get() as any;
    for (let i = 1; i <= 5; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 3000 * i });
    }
    const after = h.db.prepare("SELECT retry_policy, next_attempt_at FROM execution_jobs WHERE id = 'f2'").get() as any;
    ok(before.retry_policy === after.retry_policy, "F2 retry_policy unchanged");
    ok(before.next_attempt_at === after.next_attempt_at, "F2 next_attempt_at unchanged");
  }

  console.log("\n158-F3 renewal does not create a new operation");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f3", "A", 60000, t);
    const before = countOps(h, "f3");
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 1000 * i });
    }
    ok(countOps(h, "f3") === before, "F3 one row still");
  }

  console.log("\n158-F4 takeover increments only per existing rules");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f4", "A", 60000, t);
    ok(getOp(h, opId).attempt_count === 1, "F4 after first claim 1");
    // Renewal does not increment.
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    ok(getOp(h, opId).attempt_count === 1, "F4 after renew still 1");
    // Takeover increments once.
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(getOp(h, opId).attempt_count === 2, "F4 after takeover 2");
    // Renewal by new owner does not increment.
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "B", durationMs: 60000, now: t + 130000 });
    ok(getOp(h, opId).attempt_count === 2, "F4 after B renew still 2");
  }

  // ================================================================
  // Group G — Terminal states (5)
  // ================================================================

  console.log("\n158-G1 COMPLETED cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g1", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "G1 COMPLETED no renew");
  }

  console.log("\n158-G2 FAILED cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g2", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "G2 FAILED no renew");
  }

  console.log("\n158-G3 RECOVERY_REQUIRED cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g3", "A", 60000, t);
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "G3 RECOVERY_REQUIRED no renew");
  }

  console.log("\n158-G4 CANCELLED cannot renew");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(r.renewed === false && r.reason === "TERMINAL", "G4 CANCELLED no renew");
  }

  console.log("\n158-G5 terminal states do not resurrect via repeated renewal attempts");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g5", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    for (let i = 0; i < 5; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 + i });
    }
    ok(getOp(h, opId).state === "COMPLETED", "G5 still COMPLETED");
    ok(getOp(h, opId).claim_owner === null, "G5 claim remains cleared");
  }

  // ================================================================
  // Group H — Shutdown (4)
  // ================================================================

  console.log("\n158-H1 shutdown flag set");
  {
    const h = makeHarness();
    ok(h.engine.isShuttingDown() === false, "H1 initially false");
    h.engine.shutdown();
    ok(h.engine.isShuttingDown() === true, "H1 after shutdown true");
  }

  console.log("\n158-H2 shutdown does not release durable claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "h2", "A", 60000, t);
    h.engine.shutdown();
    const op = getOp(h, opId);
    ok(op.state === "CLAIMED", "H2 still CLAIMED");
    ok(op.claim_owner === "A", "H2 owner preserved");
    ok(op.claim_expires_at !== null, "H2 expiry preserved");
  }

  console.log("\n158-H3 shutdown prevents recoverStaleJobs from claiming new work");
  {
    const h = makeHarness();
    const t = Date.now();
    h.store.createJob(queuedJob("h3"));
    const { operation } = h.store.recoveryOps.createOrGetOperation({
      jobId: "h3", leaseId: "L3", workerId: "w3", operationType: "CANCELLATION",
    });
    // Flag before any recovery loop runs.
    h.engine.shutdown();
    h.engine.recoverStaleJobs(t);
    // recoverStaleJobs returns early on shutdown flag; op stays PENDING.
    ok(getOp(h, operation.operationId).state === "PENDING", "H3 no claim attempted under shutdown");
  }

  console.log("\n158-H4 expired work remains recoverable after shutdown");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "h4", "A", 60000, t);
    h.engine.shutdown();
    // A different store instance (simulating a different process) can take over after expiry.
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(r.claimed === true, "H4 B takes over expired claim");
    ok(getOp(h, opId).claim_owner === "B", "H4 B authoritative");
  }

  // ================================================================
  // Group I — Long-running execution / documentation
  // ================================================================

  console.log("158-I1 no recovery body is async (documentation assertion)");
  {
    // Reads the engine source to confirm the synchronous-body invariant that
    // Phase 158 relies on. If this changes, Phase 158's reasoning is invalidated
    // and a future phase must integrate renewal into the execution path.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "src", "core", "execution-engine.ts"), "utf8");
    const asyncBodyCount = (src.match(/body:\s*async\s*\(/g) ?? []).length;
    const syncBodyCount = (src.match(/body:\s*\(\)\s*=>\s*\{/g) ?? []).length;
    ok(asyncBodyCount === 0, "I1 no async recovery body exists");
    ok(syncBodyCount > 0, "I1 synchronous bodies exist");
  }

  console.log("\n158-I2 simulated long-running renewal sequence keeps ownership");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "i2", "A", 60000, t);
    // Simulate a 10-minute operation by renewing at 30s intervals.
    let now = t;
    let renewals = 0;
    for (let step = 0; step < 20; step++) {
      now += 30000;
      if (now >= expiresAt + 30000 * step) {
        // Renew well before the (current) expiry.
      }
      const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now });
      if (r.renewed) renewals++;
    }
    ok(renewals === 20, "I2 all 20 renewals succeeded");
    ok(getOp(h, opId).claim_owner === "A", "I2 A still authoritative");
    ok(getOp(h, opId).attempt_count === 1, "I2 attempt_count still 1");
    // Complete under the still-live claim.
    ok(h.store.recoveryOps.markCompleted(opId, "A", now + 1000) === true, "I2 finalize after long run");
  }

  console.log("\n158-I3 simulated long run with a mid-run stall then expiry is fenced");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "i3", "A", 60000, t);
    // Renew once at 30s; then stall (no more renewals) past the new expiry.
    h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    // The new expiry is t+90000. Attempt renewal at t+120000 — expired.
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    ok(r.renewed === false && r.reason === "EXPIRED", "I3 stalled owner fenced");
    // Takeover by B.
    const b = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(b.claimed === true, "I3 B takes over");
    // A's late mutation is rejected.
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 121000) === false, "I3 A late complete fenced");
  }

  console.log("\n158-I4 no heartbeat events created by renewal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "i4", "A", 60000, t);
    const before = countEvents(h, "i4");
    for (let i = 1; i <= 10; i++) {
      h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 3000 * i });
    }
    ok(countEvents(h, "i4") === before, "I4 no events from 10 renewals");
  }

  console.log("\n158-I5 renewal is idempotent in effect (single live claim at any instant)");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "i5", "A", 60000, t);
    // Two near-simultaneous renewal requests from the same owner.
    const r1 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 1000 });
    const r2 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 1001 });
    ok(r1.renewed === true && r2.renewed === true, "I5 both renewals succeed");
    const op = getOp(h, opId);
    ok(op.claim_owner === "A", "I5 single owner");
    ok(op.attempt_count === 1, "I5 attempt_count unchanged");
  }

  console.log("\n158-I6 no production caller invokes renewOperationClaim today (documentation)");
  {
    const { readFileSync } = await import("node:fs");
    const engineSrc = readFileSync(join(process.cwd(), "src", "core", "execution-engine.ts"), "utf8");
    const storeSrc = readFileSync(join(process.cwd(), "src", "core", "execution-recovery-operation-store.ts"), "utf8");
    // renewOperationClaim must be defined in the store...
    ok(storeSrc.includes("renewOperationClaim"), "I6 store defines renewOperationClaim");
    // ...and NOT called from the engine today (bodies are synchronous).
    ok(!engineSrc.includes("renewOperationClaim("), "I6 engine does not call renewOperationClaim");
  }

  console.log("\n--- Phase 158: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE158 DRIVER CRASH:", err); process.exit(1); });
