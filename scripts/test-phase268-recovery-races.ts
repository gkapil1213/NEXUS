// scripts/test-phase268-recovery-races.ts
// PHASE268_APPLIED
// Phase 268 section 4.A + 4.D + invariant 4 and 12.
//
// Scenario 268-A1: retry eligibility changes between inspection and claim.
//   A worker inspects the candidate list at time T1 when next_attempt_at is
//   in the future. By T2 (past the deadline), the candidate is eligible.
//   A worker holding a stale T1 observation cannot claim. A worker with T2
//   succeeds. That is: eligibility is enforced at the claim boundary, not
//   only at inspection.
//
// Scenario 268-A2: stale recovery racing a newer attempt.
//   Recovery claims an expired op, marks in-progress, and then a newer owner
//   reclaims the job. The stale owner cannot complete, fail, or mark
//   RecoveryRequired on the op.

import Database from "better-sqlite3";
import { join } from "path";
import { unlinkSync } from "fs";
import os from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string {
  return `p268-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clean(p: string): void {
  for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} }
}

function makeSqliteHarness(path: string): {
  rawDb: Database.Database;
  store: ExecutionStore;
  engine: ExecutionEngine;
} {
  const rawDb = new Database(path);
  new MigrationRunner(rawDb, join(process.cwd(), "src", "db", "migrations")).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  return { rawDb, store, engine };
}

function makeJob(id: string, status = "FAILED"): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "p268-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}

async function main() {
  console.log("=== Phase 268 - Recovery Races (retry eligibility + stale owner) ===\n");

  // ==========================================================
  // 268-A1: retry eligibility changes between inspection and claim
  // ==========================================================
  section("268-A1 retry eligibility changes between inspection and claim");
  {
    const dbPath = join(os.tmpdir(), `nexus-p268-a1-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    const jobId = uniq("a1");
    h.store.createJob(makeJob(jobId, "FAILED"));
    const ops: any = (h.store as any).recoveryOps;
    const c = await ops.createOrGetOperation({
      jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1,
    });
    const opId = c.operation.operationId;

    // Mark the op FAILED with a future next_attempt_at (ineligible at T1).
    // We have to seed the FAILED state. The store gives us a clean path:
    // claim it with a short TTL, mark failed with a retryable class and a
    // future next attempt.
    await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60000, now: 1000 });
    await ops.markFailed(opId, "seeder", "request TIMEOUT", 1000, {
      failureClass: "RETRYABLE", nextAttemptAt: 1000 + 60_000,
    });

    // At T1 = 1000, the op is not resumable (next_attempt_at 61_000 > 1000).
    const atT1 = await ops.listResumableOperations(1000);
    ok(atT1.every((o: any) => o.operationId !== opId),
      "268-A1 at T1=1000: op excluded from resumable list");

    // Stale worker holding T1 inspection tries to claim at T1.
    const staleClaim = await ops.claimOperation({ operationId: opId, owner: "staleWorker", durationMs: 60000, now: 1000 });
    ok(staleClaim.claimed === false,
      "268-A1 stale worker (now=1000) refused claim: eligibility enforced at boundary");

    // At T2 = 62_000, the op IS resumable.
    const atT2 = await ops.listResumableOperations(62_000);
    ok(atT2.some((o: any) => o.operationId === opId),
      "268-A1 at T2=62000: op included in resumable list");

    // Fresh worker with T2 succeeds.
    const freshClaim = await ops.claimOperation({ operationId: opId, owner: "freshWorker", durationMs: 60000, now: 62_000 });
    ok(freshClaim.claimed === true,
      "268-A1 fresh worker (now=62000) succeeds claim");

    // Persisted state reflects the new owner.
    const persisted = await ops.getOperation(opId);
    ok(persisted.claimOwner === "freshWorker",
      "268-A1 persisted claim_owner is freshWorker (got " + persisted.claimOwner + ")");

    h.rawDb.close();
    clean(dbPath);
  }

  // ==========================================================
  // 268-A2: stale recovery racing a newer attempt
  // ==========================================================
  section("268-A2 stale recovery racing newer attempt");
  {
    const dbPath = join(os.tmpdir(), `nexus-p268-a2-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    const jobId = uniq("a2");
    h.store.createJob(makeJob(jobId, "FAILED"));
    const ops: any = (h.store as any).recoveryOps;

    // Stale worker claims with short TTL, marks in-progress.
    const c = await ops.createOrGetOperation({
      jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1,
    });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "staleWorker", durationMs: 1000, now: 1000 });
    await ops.markInProgress(opId, "staleWorker", 1000);

    // Newer owner reclaims after TTL.
    const reclaim = await ops.claimOperation({ operationId: opId, owner: "newOwner", durationMs: 60000, now: 3000 });
    ok(reclaim.claimed === true, "268-A2 new owner reclaims after TTL");
    const after = await ops.getOperation(opId);
    ok(after.claimOwner === "newOwner", "268-A2 persisted owner is newOwner");

    // Stale worker tries every terminal mutation - all refused.
    const fail1 = await ops.markCompleted(opId, "staleWorker", 3000);
    ok(fail1 === false, "268-A2 stale markCompleted refused");

    const fail2 = await ops.markFailed(opId, "staleWorker", "attempted overwrite", 3000);
    ok(fail2 === false, "268-A2 stale markFailed refused");

    const fail3 = await ops.markRecoveryRequired(opId, "staleWorker", "attempted overwrite", 3000);
    ok(fail3 === false, "268-A2 stale markRecoveryRequired refused");

    // Persisted state unchanged after all stale attempts.
    const final = await ops.getOperation(opId);
    ok(final.state === "CLAIMED" && final.claimOwner === "newOwner",
      "268-A2 final state CLAIMED owned by newOwner (state=" + final.state + ", owner=" + final.claimOwner + ")");

    h.rawDb.close();
    clean(dbPath);
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });