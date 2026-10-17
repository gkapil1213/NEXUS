// scripts/test-phase269-recovery-observability.ts
// PHASE269_APPLIED
// Phase 269 section 2.A: recovery observability.
//
// A1: every operation carries correlation fields (7 assertions).
// A2: each escalation path persists a legible last_error (6 assertions).
// A3: recovery-path events persisted to execution_events contain no
//     secret-like substrings. This test queries the durable event table
//     directly, because the recovery path writes events via
//     ExecutionStore.addEvent (SQL INSERT), not via deps.events.emit.
//     It also asserts count > 0 so an empty table cannot masquerade as
//     "no secrets found".
//
// Audit coverage is NOT asserted here: the recovery-op reconcile path
// does not call deps.audit.record. Documented as NOT COVERED in the report.

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
  return `p269-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    id, idempotencyKey: "p269-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}
const SECRET_KEYS = ["password","passwd","token","secret","authorization",
                     "connectionstring","connection_string","database_url",
                     "api_key","apikey","bearer"];
function containsSecretLikeText(text: string | null): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  return SECRET_KEYS.some(k => low.includes(k));
}

async function main() {
  console.log("=== Phase 269 - Recovery Observability ===\n");

  section("269-A1 operation carries correlation fields");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-a1-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    try {
      const jobId = uniq("a1");
      h.store.createJob(makeJob(jobId));
      const ops: any = (h.store as any).recoveryOps;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1000,
      });
      const op = await ops.getOperation(c.operation.operationId);
      ok(typeof op.operationId === "string" && op.operationId.length > 0, "269-A1 operation_id populated");
      ok(op.jobId === jobId, "269-A1 job_id matches");
      ok(op.leaseId === null, "269-A1 lease_id nullable");
      ok(op.workerId === "w", "269-A1 worker_id retained");
      ok(op.operationType === "TIMEOUT", "269-A1 operation_type retained");
      ok(op.attemptCount === 0, "269-A1 attempt_count starts at 0");
      ok(op.claimOwner === null, "269-A1 claim_owner null before claim");
    } finally {
      h.rawDb.close(); clean(dbPath);
    }
  }

  section("269-A2 escalation reasons in last_error");
  {
    // MAX_RECOVERY_ATTEMPTS_EXCEEDED_5
    {
      const dbPath = join(os.tmpdir(), `nexus-p269-a2a-${Date.now()}.sqlite`);
      clean(dbPath);
      const h = makeSqliteHarness(dbPath);
      try {
        const jobId = uniq("a2a");
        h.store.createJob(makeJob(jobId));
        const ops: any = (h.store as any).recoveryOps;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1 });
        const opId = c.operation.operationId;
        for (let i = 0; i < 5; i++) {
          await ops.claimOperation({ operationId: opId, owner: "s" + i, durationMs: 60000, now: 1000 });
          await ops.markFailed(opId, "s" + i, "simulated " + i, 1000 + i);
        }
        await h.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
        const after = await ops.getOperation(opId);
        ok(after.state === "RECOVERY_REQUIRED", "269-A2a state=RECOVERY_REQUIRED (got " + after.state + ")");
        ok((after.lastError || "").includes("MAX_RECOVERY_ATTEMPTS_EXCEEDED_5"), "269-A2a last_error names MAX_RECOVERY_ATTEMPTS_EXCEEDED_5");
      } finally { h.rawDb.close(); clean(dbPath); }
    }
    // JOB_NOT_FOUND_DURING_RECONCILE
    {
      const dbPath = join(os.tmpdir(), `nexus-p269-a2b-${Date.now()}.sqlite`);
      clean(dbPath);
      const h = makeSqliteHarness(dbPath);
      try {
        const jobId = uniq("a2b");
        const ops: any = (h.store as any).recoveryOps;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
        const opId = c.operation.operationId;
        await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);
        const after = await ops.getOperation(opId);
        ok(after.state === "RECOVERY_REQUIRED", "269-A2b missing job -> RECOVERY_REQUIRED");
        ok((after.lastError || "").includes("JOB_NOT_FOUND_DURING_RECONCILE"), "269-A2b last_error names JOB_NOT_FOUND");
      } finally { h.rawDb.close(); clean(dbPath); }
    }
    // INCONSISTENT_JOB_STATE_<status>
    {
      const dbPath = join(os.tmpdir(), `nexus-p269-a2c-${Date.now()}.sqlite`);
      clean(dbPath);
      const h = makeSqliteHarness(dbPath);
      try {
        const jobId = uniq("a2c");
        h.store.createJob(makeJob(jobId, "SUCCEEDED"));
        const ops: any = (h.store as any).recoveryOps;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "CANCELLATION", now: 1 });
        const opId = c.operation.operationId;
        await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);
        const after = await ops.getOperation(opId);
        ok(after.state === "RECOVERY_REQUIRED", "269-A2c inconsistent state -> RECOVERY_REQUIRED");
        ok((after.lastError || "").includes("INCONSISTENT_JOB_STATE_"), "269-A2c last_error names INCONSISTENT_JOB_STATE_");
      } finally { h.rawDb.close(); clean(dbPath); }
    }
  }

  section("269-A3 recovery-path events contain no secrets");
  {
    const dbPath = join(os.tmpdir(), `nexus-p269-a3-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    try {
      const jobId = uniq("a3");
      // Drive a real recovery path that emits events via addEvent():
      //   ORPHAN_RECOVERY op on an ORPHANED job -> reconcile -> recoverJobAtomic
      h.store.createJob(makeJob(jobId, "ORPHANED"));
      const ops: any = (h.store as any).recoveryOps;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: "", workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);

      // Read events directly from the durable table
      const rows = h.rawDb.prepare(
        "SELECT event_id, event_type, payload FROM execution_events WHERE job_id = ?"
      ).all(jobId) as Array<{ event_id: string; event_type: string; payload: string | null }>;

      ok(rows.length > 0,
        "269-A3 event table produced " + rows.length + " row(s) for recovery path (count > 0 required)");

      if (rows.length === 0) {
        // Already failed above; do not scan an empty set and call it pass.
        ok(false, "269-A3 cannot scan secrets: no events emitted, so the check is not meaningful");
      } else {
        let anySecret = false;
        let secretIn: string | null = null;
        for (const r of rows) {
          if (containsSecretLikeText(r.event_type) || containsSecretLikeText(r.payload)) {
            anySecret = true;
            secretIn = r.event_id;
            break;
          }
        }
        ok(!anySecret,
          "269-A3 no secret-like substring across " + rows.length + " recovery event payload(s)" +
          (secretIn ? " (found in " + secretIn + ")" : ""));
      }

      // Record the operation's terminal state for the report
      const op = await ops.getOperation(opId);
      ok(op.state !== "PENDING" && op.state !== "CLAIMED" && op.state !== "IN_PROGRESS",
        "269-A3 operation reached a terminal-for-reconcile state (state=" + op.state + ")");
    } finally {
      h.rawDb.close(); clean(dbPath);
    }
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