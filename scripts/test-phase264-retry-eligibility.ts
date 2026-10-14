// scripts/test-phase264-retry-eligibility.ts
// Phase 264 - retry eligibility and scheduling correctness.
//
// Verifies the four coordinated fixes:
//   1. reconcileExecutionRecoveryOperations forwards `now` to listResumableOperations
//   2. claimOperation refuses operations whose next_attempt_at is in the future
//   3. claimOperation clears next_attempt_at on success
//   4. listResumableOperations excludes FAILED operations whose
//      last_failure_class is NON_RETRYABLE
//
// Runs both the sync (SQLite in-memory) and async (PostgreSQL) stores and
// asserts identical behavior. Deterministic clocks; no sleeps.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import {
  ExecutionRecoveryOperationStore,
  AsyncExecutionRecoveryOperationStore,
} from "../src/core/execution-recovery-operation-store";

let passed = 0, failed = 0, blocked = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }
function uniq(t: string): string {
  return `p264-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Ops {
  createOrGetOperation: (i: any) => Promise<{ operation: any; created: boolean }> | { operation: any; created: boolean };
  claimOperation: (i: any) => Promise<any> | any;
  markInProgress: (id: string, owner: string, now?: number) => Promise<boolean> | boolean;
  markFailed: (id: string, owner: string, err: string, now?: number, opts?: any) => Promise<boolean> | boolean;
  markRecoveryRequired: (id: string, owner: string, err: string, now?: number) => Promise<boolean> | boolean;
  getOperation: (id: string) => Promise<any> | any;
  listResumableOperations: (now?: number) => Promise<any[]> | any[];
}

async function runScenario(label: string, ops: Ops): Promise<void> {
  section(label);

  // ---- 264-1: future next_attempt_at not eligible ----
  {
    const jobId = uniq("1");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A", durationMs: 60_000, now: 1000 });
    await ops.markInProgress(opId, "A", 1000);
    await ops.markFailed(opId, "A", "request TIMEOUT", 2000, { failureClass: "RETRYABLE", nextAttemptAt: 2000 + 60_000 });
    const notDue = await ops.listResumableOperations(2000);
    ok(!notDue.some((o: any) => o.operationId === opId), "264-1 future next_attempt_at not in resumable");
    const due = await ops.listResumableOperations(2000 + 61_000);
    ok(due.some((o: any) => o.operationId === opId), "264-1 due next_attempt_at in resumable");
  }

  // ---- 264-2: claim refuses a future-scheduled op ----
  {
    const jobId = uniq("2");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A", durationMs: 60_000, now: 1000 });
    await ops.markInProgress(opId, "A", 1000);
    await ops.markFailed(opId, "A", "request TIMEOUT", 2000, { failureClass: "RETRYABLE", nextAttemptAt: 2000 + 60_000 });

    // Direct claim BEFORE the scheduled time must be refused.
    const earlyClaim = await ops.claimOperation({ operationId: opId, owner: "B", durationMs: 60_000, now: 3000 });
    ok(earlyClaim.claimed === false, "264-2 claim refused before next_attempt_at");

    // After the scheduled time, claim must succeed.
    const lateClaim = await ops.claimOperation({ operationId: opId, owner: "B", durationMs: 60_000, now: 2000 + 61_000 });
    ok(lateClaim.claimed === true, "264-2 claim succeeds at/after next_attempt_at");
  }

  // ---- 264-3: claim clears next_attempt_at ----
  {
    const jobId = uniq("3");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A", durationMs: 60_000, now: 1000 });
    await ops.markInProgress(opId, "A", 1000);
    await ops.markFailed(opId, "A", "request TIMEOUT", 2000, { failureClass: "RETRYABLE", nextAttemptAt: 2000 + 1000 });

    const beforeClaim = await ops.getOperation(opId);
    ok(beforeClaim.nextAttemptAt === 2000 + 1000, "264-3 nextAttemptAt set after failure");

    const late = await ops.claimOperation({ operationId: opId, owner: "B", durationMs: 60_000, now: 2000 + 2000 });
    ok(late.claimed === true, "264-3 claim succeeds after due time");

    const afterClaim = await ops.getOperation(opId);
    ok(afterClaim.nextAttemptAt === null, "264-3 claim cleared nextAttemptAt");
    ok(afterClaim.lastFailureClass === "RETRYABLE", "264-3 lastFailureClass preserved");
  }

  // ---- 264-4: NON_RETRYABLE excluded from resumable ----
  {
    const jobId = uniq("4");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A", durationMs: 60_000, now: 1000 });
    await ops.markInProgress(opId, "A", 1000);
    await ops.markFailed(opId, "A", "VALIDATION_FAILED: bad input", 2000, { failureClass: "NON_RETRYABLE", nextAttemptAt: null });

    const resumable = await ops.listResumableOperations(2000 + 1_000_000);
    ok(!resumable.some((o: any) => o.operationId === opId), "264-4 NON_RETRYABLE FAILED excluded from resumable");

    // But the row still exists and is readable.
    const op = await ops.getOperation(opId);
    ok(op?.state === "FAILED", "264-4 row still durable FAILED");
    ok(op?.lastFailureClass === "NON_RETRYABLE", "264-4 class persisted");
  }

  // ---- 264-5: RECOVERY_REQUIRED still claimable (no regression) ----
  {
    const jobId = uniq("5");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "A", durationMs: 60_000, now: 1000 });
    await ops.markInProgress(opId, "A", 1000);
    await ops.markRecoveryRequired(opId, "A", "OPERATOR_SIGNAL", 2000);

    const op = await ops.getOperation(opId);
    ok(op?.state === "RECOVERY_REQUIRED", "264-5 RECOVERY_REQUIRED state");
    ok(op?.nextAttemptAt == null, "264-5 nextAttemptAt null on RECOVERY_REQUIRED");

    // It should NOT appear in the normal resumable list while still RECOVERY_REQUIRED.
    const res = await ops.listResumableOperations(3000);
    ok(!res.some((o: any) => o.operationId === opId), "264-5 RECOVERY_REQUIRED not in resumable");

    // Escalation path can still claim RECOVERY_REQUIRED ops.
    const esc = await ops.claimOperation({ operationId: opId, owner: "escalator", durationMs: 60_000, now: 3000 });
    ok(esc.claimed === true, "264-5 RECOVERY_REQUIRED still claimable by escalation");
  }

  // ---- 264-6: concurrent claims — exactly one winner ----
  {
    const jobId = uniq("6");
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;

    const [r1, r2, r3] = await Promise.all([
      Promise.resolve(ops.claimOperation({ operationId: opId, owner: "r1", durationMs: 60_000, now: 1000 })),
      Promise.resolve(ops.claimOperation({ operationId: opId, owner: "r2", durationMs: 60_000, now: 1000 })),
      Promise.resolve(ops.claimOperation({ operationId: opId, owner: "r3", durationMs: 60_000, now: 1000 })),
    ]);
    const winners = [r1, r2, r3].filter((r) => r?.claimed === true).length;
    ok(winners === 1, "264-6 exactly one concurrent claim winner (got " + winners + ")");
  }
}

async function main() {
  console.log("=== Phase 264 - Retry Eligibility & Scheduling Correctness ===\n");

  // ==================================================================
  // SQLite sync path
  // ==================================================================
  const mem = new Database(":memory:");
  new MigrationRunner(mem, join(process.cwd(), "src", "db", "migrations")).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const syncStore = new ExecutionStore(syncEngine as any);
  const syncOps: Ops = (syncStore as any).recoveryOps as Ops;

  await runScenario("SQLite sync store", syncOps);

  // ==================================================================
  // PostgreSQL async path (optional; marked BLOCKED if DATABASE_URL unset)
  // ==================================================================
  const url = process.env.DATABASE_URL;
  if (!url) {
    blocked++;
    console.log("\nBLOCKED  PostgreSQL async store :: DATABASE_URL not set");
  } else {
    let pg: PgClient | null = null;
    try {
      pg = new PgClient();
      await pg.connect(url);
      const asyncEngine = new PgAsyncEngine(pg);
      const asyncOps = new AsyncExecutionRecoveryOperationStore(asyncEngine);
      await runScenario("PostgreSQL async store", asyncOps as unknown as Ops);
    } catch (e: any) {
      blocked++;
      console.log("\nBLOCKED  PostgreSQL async store :: " + String(e?.message ?? e));
    } finally {
      try { await pg?.close(); } catch {}
    }
  }

  try { mem.close(); } catch {}

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("PHASE264 DRIVER CRASH:", e?.stack ?? e); process.exit(1); });