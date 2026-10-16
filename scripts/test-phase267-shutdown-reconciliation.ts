// scripts/test-phase267-shutdown-reconciliation.ts
// Phase 267 section 3 scenario 5 + section 4 shutdown invariants.
import Database from "better-sqlite3";
import path from "path";
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
function uniq(t: string): string { return `p267s-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; }

function makeHarness() {
  const raw = new Database(":memory:");
  new MigrationRunner(raw, path.join(process.cwd(), "src", "db", "migrations")).run();
  const db = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(db as any);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  return { raw, store, engine };
}
function makeJob(id: string): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "p267s-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status: "FAILED",
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}
async function main() {
  console.log("=== Phase 267 - Shutdown / Reconciliation Integrity ===\n");

  section("Sc267-S1 shutdown flag");
  {
    const { engine } = makeHarness();
    ok(engine.isShuttingDown() === false, "Sc267-S1 initial: not shutting down");
    engine.markShuttingDown();
    ok(engine.isShuttingDown() === true, "Sc267-S1 flag set after markShuttingDown()");
    engine.markShuttingDown();
    ok(engine.isShuttingDown() === true, "Sc267-S1 idempotent re-mark");
  }

  section("Sc267-S2 reconcile no-op after shutdown");
  {
    const { store, engine } = makeHarness();
    const jobId = uniq("s2");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    engine.markShuttingDown();
    await engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const row = db.prepare("SELECT * FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any;
    ok(row.state === "PENDING", "Sc267-S2 op remains PENDING after shutdown (got " + row.state + ")");
    ok(row.claim_owner === null, "Sc267-S2 no claim owner assigned after shutdown");
  }

  section("Sc267-S3 durable claims survive shutdown");
  {
    const { store, engine } = makeHarness();
    const jobId = uniq("s3");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 60000, now: 1000 });
    const before = await ops.getOperation(opId);
    engine.markShuttingDown();
    const after = await ops.getOperation(opId);
    ok(after.claimOwner === before.claimOwner, "Sc267-S3 claim_owner preserved");
    ok(after.state === "CLAIMED", "Sc267-S3 state preserved (got " + after.state + ")");
  }

  section("Sc267-S4 no false completion on shutdown");
  {
    const { store, engine } = makeHarness();
    const jobId = uniq("s4");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 60000, now: 1000 });
    await ops.markInProgress(opId, "engineA", 1000);
    engine.markShuttingDown();
    await engine.reconcileExecutionRecoveryOperations(2_000_000, Infinity);
    const after = await ops.getOperation(opId);
    ok(after.state !== "COMPLETED", "Sc267-S4 IN_PROGRESS not falsely COMPLETED (got " + after.state + ")");
  }

  section("Sc267-S5 in-flight op reclaimable after TTL");
  {
    const { store } = makeHarness();
    const jobId = uniq("s5");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 1000, now: 1 });
    await ops.markInProgress(opId, "engineA", 1);
    const r = await ops.claimOperation({ operationId: opId, owner: "engineB", durationMs: 60000, now: 2000 });
    ok(r.claimed === true, "Sc267-S5 engineB reclaims after TTL");
    const after = await ops.getOperation(opId);
    ok(after.claimOwner === "engineB", "Sc267-S5 owner is engineB");
  }

  section("Sc267-S6 live claim not stolen by peer shutdown");
  {
    const { store, engine: engineB } = makeHarness();
    const jobId = uniq("s6");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 600_000, now: 1000 });
    engineB.markShuttingDown();
    await engineB.reconcileExecutionRecoveryOperations(2000, Infinity);
    const after = await ops.getOperation(opId);
    ok(after.claimOwner === "engineA", "Sc267-S6 live claim preserved (owner=" + after.claimOwner + ")");
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
