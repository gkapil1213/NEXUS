// scripts/test-phase155-strict-recovery-cancellation-fencing.ts
// Phase 155 - strict recovery cancellation fencing.

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
function getOp(h: H, opId: string) {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}
function countOps(h: H, jobId: string): number {
  return (h.db.prepare("SELECT COUNT(*) AS n FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any).n;
}
function mkOp(h: H, jobId: string, owner: string, durationMs = 60000, at = Date.now()): { opId: string; expiresAt: number } {
  h.store.createJob(queuedJob(jobId));
  const { operation } = h.store.recoveryOps.createOrGetOperation({
    jobId, leaseId: "L-" + jobId, workerId: "w-" + jobId, operationType: "CANCELLATION",
  });
  h.store.recoveryOps.claimOperation({ operationId: operation.operationId, owner, durationMs, now: at });
  return { opId: operation.operationId, expiresAt: at + durationMs };
}

async function main() {
  console.log("=== Phase 155 - Strict Recovery Cancellation Fencing ===\n");

  console.log("155-A1 live owner can cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a1", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 30000 });
    ok(r.cancelled === true, "A1 cancels");
    ok(getOp(h, opId).state === "CANCELLED", "A1 durable CANCELLED");
  }

  console.log("\n155-A2 exact expiry rejects cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "a2", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt });
    ok(r.cancelled === false && r.reason === "EXPIRED", "A2 exact-boundary EXPIRED");
    ok(getOp(h, opId).state === "CLAIMED", "A2 state unchanged");
  }

  console.log("\n155-A3 just-before-expiry allows cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "a3", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt - 1 });
    ok(r.cancelled === true, "A3 just-before cancels");
    ok(getOp(h, opId).state === "CANCELLED", "A3 CANCELLED");
  }

  console.log("\n155-A4 expired owner cannot cancel");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a4", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "EXPIRED", "A4 expired rejected");
    ok(getOp(h, opId).claim_owner === "A", "A4 owner field unchanged");
  }

  console.log("\n155-A5 expired owner cannot cancel before takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a5", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "EXPIRED", "A5 rejected pre-takeover");
  }

  console.log("\n155-A6 expired owner cannot cancel after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a6", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "A6 A rejected after takeover");
  }

  console.log("\n155-A7 missing op returns NOT_FOUND");
  {
    const h = makeHarness();
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: "no-such-op", owner: "A" });
    ok(r.cancelled === false && r.reason === "NOT_FOUND", "A7 NOT_FOUND");
  }

  console.log("\n155-A8 terminal op rejects cancellation");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "a8", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "A8 TERMINAL");
  }

  console.log("\n155-B1 non-owner cannot cancel live claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b1", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t + 1000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "B1 B rejected");
  }

  console.log("\n155-B2 non-owner cannot cancel expired claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b2", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "B2 OWNERSHIP_LOST");
  }

  console.log("\n155-B3 new owner can cancel after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b3", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t + 130000 });
    ok(r.cancelled === true, "B3 B cancels");
    ok(getOp(h, opId).state === "CANCELLED", "B3 CANCELLED");
  }

  console.log("\n155-B4 old owner cannot cancel after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b4", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "B4 A rejected");
  }

  console.log("\n155-B5 old owner cannot renew after expiry");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b5", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    ok(r.renewed === false && r.reason === "EXPIRED", "B5 renew EXPIRED");
  }

  console.log("\n155-B6 old owner cannot complete after expiry");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b6", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 120000) === false, "B6 complete rejected");
  }

  console.log("\n155-B7 old owner cannot fail after expiry");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b7", "A", 60000, t);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 120000) === false, "B7 fail rejected");
  }

  console.log("\n155-B8 old owner cannot mark recovery required after expiry");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "b8", "A", 60000, t);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 120000) === false, "B8 recovery-required rejected");
  }

  console.log("\n155-C1 cancel before takeover: A expired rejected, B can claim");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c1", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false, "C1 A rejected");
    const b = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(b.claimed === true, "C1 B can still claim");
    ok(getOp(h, opId).claim_owner === "B", "C1 owner is B");
  }

  console.log("\n155-C2 cancel after takeover: A rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c2", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "C2 A rejected");
  }

  console.log("\n155-C3 cancel vs renew: renew first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "c3", "A", 60000, t);
    const renew = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: expiresAt - 1000 });
    ok(renew.renewed === true, "C3 renew first");
    const cancel = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt - 500 });
    ok(cancel.cancelled === true, "C3 cancel after renew");
    ok(getOp(h, opId).state === "CANCELLED", "C3 CANCELLED");
  }

  console.log("\n155-C4 cancel vs renew: cancel first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c4", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const renew = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 2000 });
    ok(renew.renewed === false && renew.reason === "TERMINAL", "C4 renew rejected after cancel");
  }

  console.log("\n155-C5 cancel vs completion: completion first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c5", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "C5 cancel rejected");
    ok(getOp(h, opId).state === "COMPLETED", "C5 COMPLETED preserved");
  }

  console.log("\n155-C6 cancel vs failure: failure first");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c6", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "C6 cancel rejected");
  }

  console.log("\n155-C7 duplicate cancel converges");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "c7", "A", 60000, t);
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const r2 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r1.cancelled === true && !r1.alreadyCancelled, "C7 first applies");
    ok(r2.cancelled === true && r2.alreadyCancelled === true, "C7 second idempotent");
  }

  console.log("\n155-C8 exact-boundary race");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId, expiresAt } = mkOp(h, "c8", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt });
    ok(r.cancelled === false && r.reason === "EXPIRED", "C8 exact-boundary rejects");
    const r2 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: expiresAt - 1 });
    ok(r2.cancelled === true, "C8 just-before succeeds");
  }

  console.log("\n155-D1 CANCELLED is terminal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d1", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(getOp(h, opId).state === "CANCELLED", "D1 CANCELLED");
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(r.claimed === false, "D1 cannot be reclaimed");
  }

  console.log("\n155-D2 COMPLETED cannot become CANCELLED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d2", "A", 60000, t);
    h.store.recoveryOps.markCompleted(opId, "A", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "D2 rejected");
    ok(getOp(h, opId).state === "COMPLETED", "D2 preserved");
  }

  console.log("\n155-D3 FAILED cannot become CANCELLED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d3", "A", 60000, t);
    h.store.recoveryOps.markFailed(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "D3 rejected");
  }

  console.log("\n155-D4 RECOVERY_REQUIRED cannot become CANCELLED");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d4", "A", 60000, t);
    h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 1000);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.cancelled === false && r.reason === "TERMINAL", "D4 rejected");
  }

  console.log("\n155-D5 CANCELLED cannot be reclaimed");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d5", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    for (let i = 0; i < 3; i++) {
      const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 + i });
      ok(r.claimed === false, "D5 attempt " + (i + 1) + " rejected");
    }
  }

  console.log("\n155-D6 CANCELLED absent from resumable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "d6", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    const res = h.store.recoveryOps.listResumableOperations();
    ok(!res.some((o: any) => o.operationId === opId), "D6 not resumable");
  }

  console.log("\n155-E1 cancel does not increment attempt_count");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "e1", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(getOp(h, opId).attempt_count === before, "E1 attempt_count unchanged");
  }

  console.log("\n155-E2 DB close/reopen preserves CANCELLED");
  {
    const dir = mkdtempSync(join(tmpdir(), "p155-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "e2", "A", 60000, t);
      h1.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
      h1.db.close();
      const h2 = makeHarness(dbFile);
      ok(getOp(h2, opId).state === "CANCELLED", "E2 durable");
      ok(getOp(h2, opId).claim_owner === null, "E2 claim cleared");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n155-E3 DB reopen preserves expired non-cancelled op");
  {
    const dir = mkdtempSync(join(tmpdir(), "p155-"));
    const dbFile = join(dir, "test.db");
    try {
      const h1 = makeHarness(dbFile);
      const t = Date.now();
      const { opId } = mkOp(h1, "e3", "A", 60000, t);
      h1.db.close();
      const h2 = makeHarness(dbFile);
      const r = h2.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
      ok(r.cancelled === false && r.reason === "EXPIRED", "E3 still fenced after reopen");
      h2.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log("\n155-E4 stale worker cannot reclaim after takeover");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "e4", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    ok(r.cancelled === false && r.reason === "OWNERSHIP_LOST", "E4 A fenced");
    const c = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t + 130000 });
    ok(c.cancelled === true, "E4 B can cancel");
  }

  console.log("\n155-E5 new worker reclaims expired non-cancelled op");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "e5", "A", 60000, t);
    const r = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    ok(r.claimed === true, "E5 B claims");
    ok(h.store.recoveryOps.markCompleted(opId, "B", t + 130000) === true, "E5 B completes");
  }

  console.log("\n155-E6 attempt_count preserved");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "e6", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(getOp(h, opId).attempt_count === 1, "E6 still 1");
  }

  console.log("\n155-F1 stale renew rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f1", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    ok(r.renewed === false, "F1 renew rejected");
  }

  console.log("\n155-F2 stale cancel rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f2", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "EXPIRED", "F2 cancel rejected EXPIRED");
  }

  console.log("\n155-F3 stale complete rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f3", "A", 60000, t);
    ok(h.store.recoveryOps.markCompleted(opId, "A", t + 120000) === false, "F3 complete rejected");
  }

  console.log("\n155-F4 stale fail rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f4", "A", 60000, t);
    ok(h.store.recoveryOps.markFailed(opId, "A", "err", t + 120000) === false, "F4 fail rejected");
  }

  console.log("\n155-F5 stale recovery-required rejected");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f5", "A", 60000, t);
    ok(h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 120000) === false, "F5 recovery-required rejected");
  }

  console.log("\n155-F6 new claim restores authority");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f6", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "A", durationMs: 60000, now: t + 120000 });
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    ok(r.cancelled === true, "F6 A cancels under new claim");
  }

  console.log("\n155-F7 worker ID alone cannot restore authority");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f7", "A", 60000, t);
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 120000 });
    ok(r.cancelled === false && r.reason === "EXPIRED", "F7 A fenced by expiry");
  }

  console.log("\n155-F8 stale worker after takeover full fencing");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "f8", "A", 60000, t);
    h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 120000 });
    const r1 = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 130000 });
    const r2 = h.store.recoveryOps.markCompleted(opId, "A", t + 130000);
    const r3 = h.store.recoveryOps.markFailed(opId, "A", "err", t + 130000);
    const r4 = h.store.recoveryOps.markRecoveryRequired(opId, "A", "err", t + 130000);
    const r5 = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 130000 });
    ok(r1.cancelled === false, "F8 cancel rejected");
    ok(r2 === false, "F8 complete rejected");
    ok(r3 === false, "F8 fail rejected");
    ok(r4 === false, "F8 RR rejected");
    ok(r5.renewed === false, "F8 renew rejected");
  }

  console.log("\n155-G1 Phase 152 concurrent claim integrity");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g1", "A", 60000, t);
    const b = h.store.recoveryOps.claimOperation({ operationId: opId, owner: "B", durationMs: 60000, now: t + 1000 });
    ok(b.claimed === false, "G1 B rejected while A live");
  }

  console.log("\n155-G2 Phase 153 renewal integrity");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g2", "A", 60000, t);
    const r = h.store.recoveryOps.renewOperationClaim({ operationId: opId, owner: "A", durationMs: 60000, now: t + 30000 });
    ok(r.renewed === true, "G2 renew live");
  }

  console.log("\n155-G3 Phase 154 CANCELLED terminal");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g3", "A", 60000, t);
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    ok(getOp(h, opId).state === "CANCELLED", "G3 CANCELLED");
    const r = h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(r.alreadyCancelled === true, "G3 replay idempotent");
  }

  console.log("\n155-G4 operation count stable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g4", "A", 60000, t);
    const before = countOps(h, "g4");
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    ok(countOps(h, "g4") === before, "G4 one op row");
  }

  console.log("\n155-G5 no duplicate recovery events");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g5", "A", 60000, t);
    const before = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = 'g5'").get() as any).n;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 2000 });
    const after = (h.db.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE job_id = 'g5'").get() as any).n;
    ok(after === before, "G5 no events added");
  }

  console.log("\n155-G6 retry budget stable");
  {
    const h = makeHarness();
    const t = Date.now();
    const { opId } = mkOp(h, "g6", "A", 60000, t);
    const before = getOp(h, opId).attempt_count;
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "A", now: t + 1000 });
    h.store.recoveryOps.cancelOperationClaim({ operationId: opId, owner: "B", now: t + 2000 });
    ok(getOp(h, opId).attempt_count === before, "G6 attempt_count unchanged");
  }

  console.log("\n--- Phase 155: " + passed + " passed, " + failed + " failed ---");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PHASE155 DRIVER CRASH:", err); process.exit(1); });
