// scripts/test-phase269-failure-injection.ts
// PHASE269_APPLIED
// Phase 269 section 2.B: failure-injection scenarios filling the four
// genuine gaps the gap matrix identified as not already covered by
// Phase 265-268:
//
//   269-B1: retry limit reached -> RECOVERY_REQUIRED (no infinite retry)
//   269-B2: FAILED op past next_attempt_at becomes claimable again
//   269-B3: inconsistent job state escalates with INCONSISTENT_JOB_STATE_<status>
//   269-B4: shutdown mid-reconcile, restart on new engine, op resumes cleanly

import Database from "better-sqlite3";
import { join } from "path";
import { unlinkSync } from "fs";
import os from "os";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";

let passed = 0, failed = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string {
  return `p269b-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clean(p: string): void {
  for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} }
}
function makeSqliteHarness(path: string): { rawDb: Database.Database; store: ExecutionStore; engine: ExecutionEngine } {
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
    id, idempotencyKey: "p269b-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}

async function main() {
  console.log("=== Phase 269 - Failure Injection ===\n");

  // =========================================================
  // 269-B1: retry limit reached => escalation, not infinite retry
  // =========================================================
  section("269-B1 retry limit reached escalates to RECOVERY_REQUIRED");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-b1-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    try {
      const jobId = uniq("b1");
      h.store.createJob(makeJob(jobId));
      const ops: any = (h.store as any).recoveryOps;
      const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1 });
      const opId = c.operation.operationId;
      for (let i = 0; i < 5; i++) {
        await ops.claimOperation({ operationId: opId, owner: "s" + i, durationMs: 60000, now: 1000 });
        await ops.markFailed(opId, "s" + i, "retryable " + i, 1000 + i);
      }
      const before = await ops.getOperation(opId);
      ok(before.attemptCount === 5, "269-B1 pre-reconcile attempt_count 5 (got " + before.attemptCount + ")");

      await h.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const after = await ops.getOperation(opId);
      ok(after.state === "RECOVERY_REQUIRED", "269-B1 escalated to RECOVERY_REQUIRED (state=" + after.state + ")");
      ok(after.claimOwner === null, "269-B1 claim_owner cleared after escalation");

      await h.engine.reconcileExecutionRecoveryOperations(2_000_000, Infinity);
      const after2 = await ops.getOperation(opId);
      ok(after2.state === "RECOVERY_REQUIRED", "269-B1 second reconcile does not auto-retry");
      // The FIRST reconcile's escalation path claims the op (attempt_count 5->6)
      // and marks RECOVERY_REQUIRED. The SECOND reconcile must be a no-op:
      // state stays RECOVERY_REQUIRED and attempt_count stays at 6, not incremented again.
      ok(after2.attemptCount === 6, "269-B1 second reconcile did not increment attempt_count further (got " + after2.attemptCount + ")");
      ok((after2.lastError || "").includes("MAX_RECOVERY_ATTEMPTS_EXCEEDED_5"),
        "269-B1 escalation reason preserved on second reconcile");
    } finally { h.rawDb.close(); clean(dbPath); }
  }

  // =========================================================
  // 269-B2: FAILED op past deadline becomes claimable
  // =========================================================
  section("269-B2 FAILED op past deadline becomes claimable");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-b2-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    try {
      const jobId = uniq("b2");
      h.store.createJob(makeJob(jobId));
      const ops: any = (h.store as any).recoveryOps;
      const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1 });
      const opId = c.operation.operationId;
      await ops.claimOperation({ operationId: opId, owner: "s", durationMs: 60000, now: 1000 });
      await ops.markFailed(opId, "s", "transient", 1001, { failureClass: "RETRYABLE", nextAttemptAt: 5000 });

      const early = await ops.listResumableOperations(1000);
      ok(early.every((o: any) => o.operationId !== opId), "269-B2 at now=1000: op excluded from resumable");

      const stale = await ops.claimOperation({ operationId: opId, owner: "stale", durationMs: 60000, now: 1000 });
      ok(stale.claimed === false, "269-B2 stale worker (now=1000) claim refused");

      const later = await ops.listResumableOperations(6000);
      ok(later.some((o: any) => o.operationId === opId), "269-B2 at now=6000: op included in resumable");

      const fresh = await ops.claimOperation({ operationId: opId, owner: "fresh", durationMs: 60000, now: 6000 });
      ok(fresh.claimed === true, "269-B2 fresh claim succeeds");
      const after = await ops.getOperation(opId);
      ok(after.claimOwner === "fresh", "269-B2 persisted owner is fresh (got " + after.claimOwner + ")");
    } finally { h.rawDb.close(); clean(dbPath); }
  }

  // =========================================================
  // 269-B3: inconsistent job state escalates with typed reason
  // =========================================================
  section("269-B3 inconsistent job state escalates with typed reason");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-b3-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    try {
      const jobId = uniq("b3");
      h.store.createJob(makeJob(jobId, "SUCCEEDED"));
      const ops: any = (h.store as any).recoveryOps;
      const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "CANCELLATION", now: 1 });
      const opId = c.operation.operationId;
      await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);
      const after = await ops.getOperation(opId);
      ok(after.state === "RECOVERY_REQUIRED", "269-B3 escalated to RECOVERY_REQUIRED");
      ok((after.lastError || "").startsWith("INCONSISTENT_JOB_STATE_"), "269-B3 last_error begins with INCONSISTENT_JOB_STATE_");
      ok((after.lastError || "").includes("SUCCEEDED"), "269-B3 last_error names the actual job state");
    } finally { h.rawDb.close(); clean(dbPath); }
  }

  // =========================================================
  // 269-B4: shutdown mid-reconcile, restart, op resumes cleanly
  // =========================================================
  section("269-B4 shutdown mid-reconcile, restart, resume");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-b4-${Date.now()}.sqlite`);
    clean(dbPath);
    try {
      // First engine: create a durable op, mark shutdown, reconcile (no-op)
      const h1 = makeSqliteHarness(dbPath);
      const jobId = uniq("b4");
      h1.store.createJob(makeJob(jobId));
      const ops1: any = (h1.store as any).recoveryOps;
      const c = await ops1.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
      const opId = c.operation.operationId;
      h1.engine.markShuttingDown();
      await h1.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const after1 = await ops1.getOperation(opId);
      ok(after1.state === "PENDING", "269-B4 after shutdown: op remains PENDING (state=" + after1.state + ")");
      ok(after1.claimOwner === null, "269-B4 after shutdown: no claim owner");
      h1.rawDb.close();

      // Second engine: fresh instance, same DB file, reconciles successfully
      const h2 = makeSqliteHarness(dbPath);
      await h2.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const ops2: any = (h2.store as any).recoveryOps;
      const after2 = await ops2.getOperation(opId);
      ok(after2.state !== "PENDING", "269-B4 after restart: op transitioned out of PENDING (state=" + after2.state + ")");
      h2.rawDb.close();
    } finally { clean(dbPath); }
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: 0");
  console.log("NOT EXECUTED: 0");
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });