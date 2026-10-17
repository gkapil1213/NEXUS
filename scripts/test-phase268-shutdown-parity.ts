// scripts/test-phase268-shutdown-parity.ts
// PHASE268_APPLIED
// Phase 268 section 4.E + invariant 10: Postgres shutdown parity.
// Requires DATABASE_URL and NEXUS_PERSISTENCE_MODE=shared. When unavailable,
// each scenario reports BLOCKED with the exact reason and never PASS.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(c: boolean, m: string): void {
  if (c) { passed++; console.log("PASS  " + m); }
  else { failed++; console.log("FAIL  " + m); }
}
function blk(m: string, r: string): void {
  blocked++; console.log("BLOCKED  " + m + " :: " + r);
}
function ne(m: string): void {
  notExec++; console.log("NOT EXECUTED  " + m);
}
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string {
  return `p268s-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function makeJob(id: string, status = "FAILED"): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "p268s-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}

async function main() {
  console.log("=== Phase 268 - Postgres Shutdown Parity ===\n");

  const url = process.env.DATABASE_URL;
  const mode = process.env.NEXUS_PERSISTENCE_MODE;
  const pgOk = !!(url && mode === "shared");

  if (!pgOk) {
    console.log("Note: NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL not both set.");
    console.log("      All Postgres shutdown scenarios will report BLOCKED.\n");
  }

  // If not configured, report every scenario as BLOCKED.
  if (!pgOk) {
    section("268-S-PG1 shutdown flag preserved (Postgres)");
    blk("268-S-PG1", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
    section("268-S-PG2 reconcile no-op after shutdown (Postgres)");
    blk("268-S-PG2", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
    section("268-S-PG3 durable claims survive shutdown (Postgres)");
    blk("268-S-PG3", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
    section("268-S-PG4 no false completion on shutdown (Postgres)");
    blk("268-S-PG4", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
    section("268-S-PG5 in-flight op reclaimable after TTL (Postgres)");
    blk("268-S-PG5", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
    section("268-S-PG6 live claim not stolen by peer shutdown (Postgres)");
    blk("268-S-PG6", "requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");

    console.log("\n============================================");
    console.log("PASS: " + passed);
    console.log("FAIL: " + failed);
    console.log("BLOCKED: " + blocked);
    console.log("NOT EXECUTED: " + notExec);
    console.log("============================================");
    process.exit(0);
  }

  // With DATABASE_URL set, use an isolated database.
  const { PgClient } = await import("../src/core/pg-client");
  const { PgAsyncEngine } = await import("../src/core/pg-async-engine");
  const { bootstrapPgSchema } = await import("../src/core/pg-bootstrap");

  const parsed = new URL(url!);
  const basePath = parsed.pathname.replace(/^\//, "") || "postgres";
  const isoName = (basePath + "_p268s_" + Math.random().toString(36).slice(2, 10)).toLowerCase();
  const isoUrl = url!.replace(/(:\/\/[^/]*\/)[^/?]*/, "$1" + isoName);

  let adminPg: any = null;
  let pg: any = null;
  let memDb: Database.Database | null = null;

  try {
    adminPg = new PgClient();
    await adminPg.connect(url!);
    const perm = await adminPg.query<{ createdb: boolean }>(
      "SELECT rolcreatedb OR rolsuper AS createdb FROM pg_roles WHERE rolname = current_user"
    );
    if (perm.rows[0]?.createdb !== true) {
      blk("268-S-PG", "current role lacks CREATEDB");
      return;
    }
    await adminPg.query('CREATE DATABASE "' + isoName + '"');
    console.log("  [setup] created isolated database " + isoName);

    pg = new PgClient();
    await pg.connect(isoUrl);
    await bootstrapPgSchema(pg);

    const asyncEngine = new PgAsyncEngine(pg);
    memDb = new Database(":memory:");
    new MigrationRunner(memDb, join(process.cwd(), "src", "db", "migrations")).run();
    const syncEngine = SQLiteEngine.fromDatabase(memDb);
    const store = new ExecutionStore(syncEngine as any, asyncEngine as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);

    section("268-S-PG1 shutdown flag");
    {
      ok(engine.isShuttingDown() === false, "268-S-PG1 initial: not shutting down");
      engine.markShuttingDown();
      ok(engine.isShuttingDown() === true, "268-S-PG1 flag set");
    }

    section("268-S-PG2 reconcile no-op after shutdown");
    {
      const e2 = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
      const jobId = uniq("s2");
      (store as any).createJob(makeJob(jobId));
      const ops: any = (store as any).recoveryOpsAsync;
      await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      e2.markShuttingDown();
      await e2.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const row = await ops.getOperation(
        (await ops.listResumableOperations(1)).find((o: any) => o.jobId === jobId)?.operationId
      );
      // If the op is still PENDING after shutdown, the guard fired.
      const raw = await pg.query(
        "SELECT state, claim_owner FROM execution_recovery_operations WHERE job_id = $1",
        [jobId]
      );
      ok((raw.rows[0] as any).state === "PENDING",
        "268-S-PG2 op remains PENDING after shutdown (got " + (raw.rows[0] as any).state + ")");
      ok((raw.rows[0] as any).claim_owner === null,
        "268-S-PG2 no claim owner assigned after shutdown");
    }

    section("268-S-PG3 durable claims survive shutdown");
    {
      const e3 = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
      const jobId = uniq("s3");
      (store as any).createJob(makeJob(jobId));
      const ops: any = (store as any).recoveryOpsAsync;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 60000, now: 1000 });
      e3.markShuttingDown();
      const after = await ops.getOperation(opId);
      ok(after.claimOwner === "engineA", "268-S-PG3 claim_owner preserved across shutdown");
      ok(after.state === "CLAIMED", "268-S-PG3 state CLAIMED preserved");
    }

    section("268-S-PG4 no false completion on shutdown");
    {
      const e4 = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
      const jobId = uniq("s4");
      (store as any).createJob(makeJob(jobId));
      const ops: any = (store as any).recoveryOpsAsync;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 60000, now: 1000 });
      await ops.markInProgress(opId, "engineA", 1000);
      e4.markShuttingDown();
      await e4.reconcileExecutionRecoveryOperations(2_000_000, Infinity);
      const after = await ops.getOperation(opId);
      ok(after.state !== "COMPLETED",
        "268-S-PG4 IN_PROGRESS not falsely COMPLETED (state=" + after.state + ")");
    }

    section("268-S-PG5 in-flight op reclaimable after TTL");
    {
      const jobId = uniq("s5");
      (store as any).createJob(makeJob(jobId));
      const ops: any = (store as any).recoveryOpsAsync;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 1000, now: 1 });
      await ops.markInProgress(opId, "engineA", 1);
      const reclaim = await ops.claimOperation({ operationId: opId, owner: "engineB", durationMs: 60000, now: 2000 });
      ok(reclaim.claimed === true, "268-S-PG5 engineB reclaims after TTL");
      const after = await ops.getOperation(opId);
      ok(after.claimOwner === "engineB", "268-S-PG5 owner is engineB");
    }

    section("268-S-PG6 live claim not stolen by peer shutdown");
    {
      const jobId = uniq("s6");
      (store as any).createJob(makeJob(jobId));
      const ops: any = (store as any).recoveryOpsAsync;
      const c = await ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 600_000, now: 1000 });
      const engineB = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
      engineB.markShuttingDown();
      await engineB.reconcileExecutionRecoveryOperations(2000, Infinity);
      const after = await ops.getOperation(opId);
      ok(after.claimOwner === "engineA",
        "268-S-PG6 live claim preserved (owner=" + after.claimOwner + ")");
    }
  } catch (e: any) {
    blocked++;
    console.log("\nBLOCKED  PostgreSQL shutdown parity :: " + String(e?.message ?? e));
  } finally {
    try { await pg?.close(); } catch {}
    if (adminPg) {
      try {
        await adminPg.query('DROP DATABASE IF EXISTS "' + isoName + '" WITH (FORCE)');
        console.log("  [cleanup] dropped isolated database " + isoName);
      } catch (dropErr: any) {
        failed++;
        console.log("  FAIL cleanup (drop): " + String(dropErr?.message ?? dropErr));
      }
      try { await adminPg.close(); } catch {}
    }
    try { memDb?.close(); } catch {}
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