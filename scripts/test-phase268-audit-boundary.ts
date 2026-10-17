// scripts/test-phase268-audit-boundary.ts
// PHASE268_APPLIED
// Phase 268 section 4.C + invariant 11: recovery when persisted records
// are missing or inconsistent. Tests RECOVERY_REQUIRED escalation.
//
// Note: a true "fault between job-commit and event-insert" requires
// instrumenting recoverJobAtomicIO, which would mean touching production
// code for the sole purpose of testing it. Per Phase 268 section 8, this
// test covers the nearest real boundary the existing architecture exposes:
// the recovery operation running against a job that is gone or drifted.

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
  return `p268b-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function clean(p: string): void {
  for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} }
}

function makeSqliteHarness(path: string): {
  rawDb: Database.Database; store: ExecutionStore; engine: ExecutionEngine;
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
    id, idempotencyKey: "p268b-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}

async function main() {
  console.log("=== Phase 268 - Audit Boundary Escalation ===\n");

  section("268-C1 job missing at reconcile: op escalates to RECOVERY_REQUIRED");
  {
    const dbPath = join(os.tmpdir(), `nexus-p268-c1-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    const jobId = uniq("c1");

    // Create the operation against a job we never create.
    const ops: any = (h.store as any).recoveryOps;
    const c = await ops.createOrGetOperation({
      jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
    });
    const opId = c.operation.operationId;

    // Reconcile. The op is PENDING (resumable); getJobIO returns undefined.
    await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);

    const after = await ops.getOperation(opId);
    ok(after.state === "RECOVERY_REQUIRED",
      "268-C1 op escalated to RECOVERY_REQUIRED (state=" + after.state + ")");
    ok((after.lastError || "").includes("JOB_NOT_FOUND"),
      "268-C1 lastError records JOB_NOT_FOUND (got " + after.lastError + ")");

    // Re-reconcile: the op stays RECOVERY_REQUIRED (not auto-retried).
    await h.engine.reconcileExecutionRecoveryOperations(2000, Infinity);
    const after2 = await ops.getOperation(opId);
    ok(after2.state === "RECOVERY_REQUIRED",
      "268-C1 second reconcile does not auto-retry RECOVERY_REQUIRED");

    h.rawDb.close();
    clean(dbPath);
  }

  section("268-C2 terminal job NOT re-opened by recovery");
  {
    const dbPath = join(os.tmpdir(), `nexus-p268-c2-${Date.now()}.sqlite`);
    clean(dbPath);
    const h = makeSqliteHarness(dbPath);
    const jobId = uniq("c2");
    h.store.createJob(makeJob(jobId, "SUCCEEDED"));

    const ops: any = (h.store as any).recoveryOps;
    await ops.createOrGetOperation({
      jobId, leaseId: null, workerId: "w", operationType: "TIMEOUT", now: 1,
    });

    await h.engine.reconcileExecutionRecoveryOperations(1000, Infinity);

    const job: any = (h.store as any).getJob(jobId);
    ok(job.status === "SUCCEEDED",
      "268-C2 terminal job stays SUCCEEDED (got " + job.status + ")");

    h.rawDb.close();
    clean(dbPath);
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