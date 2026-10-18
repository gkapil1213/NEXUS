// scripts/test-phase270-postgres-shutdown-reconciliation.ts
// Phase 270B - PostgreSQL shutdown and reconciliation integrity.
//
// Requirements (per docs/phase270B/PHASE270B_PLAN.md):
//   S1 Post-shutdown reconciliation no-op
//   S2 Shutdown idempotency
//   S3 Pre-shutdown reconciliation control (fixture must exercise real path)
//   S4 Durability across connections
//   S5 No false completion
//   S6 Claim ownership integrity
//   S7 Error honesty
//   S8 Isolation (unique IDs, no unrelated mutation)
//
// Database safety:
//   Requires DATABASE_URL and NEXUS_PHASE270_ALLOW_PG_TESTS=1
//   Loopback host only (localhost/127.0.0.1)
//   Database name in allowlist (nexus, nexus_test, nexus_phase270_test)
//   Otherwise [BLOCKED] with specific reason, exit 0

import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import Database from "better-sqlite3";

let pass = 0, fail = 0, blocked = 0;
function ok(c: boolean, m: string, d = "") {
  if (c) { pass++; console.log("PASS  " + m + (d ? "  " + d : "")); }
  else   { fail++; console.log("FAIL  " + m + (d ? "  " + d : "")); }
}
function section(t: string) { console.log("\n--- " + t + " ---"); }
function uniq(t: string) { return `p270b-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function checkSafety(): { ok: boolean; reason?: string } {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, reason: "DATABASE_URL not set" };
  if (process.env.NEXUS_PHASE270_ALLOW_PG_TESTS !== "1") {
    return { ok: false, reason: "NEXUS_PHASE270_ALLOW_PG_TESTS must equal 1" };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "DATABASE_URL is not a valid URL" }; }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    return { ok: false, reason: "host must be loopback (localhost/127.0.0.1), got " + host };
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  const allowed = ["nexus", "nexus_test", "nexus_phase270_test"];
  if (!allowed.includes(dbName)) {
    return { ok: false, reason: "database must be one of [" + allowed.join(",") + "], got " + dbName };
  }
  return { ok: true };
}

async function openStore(url: string): Promise<{
  pg: PgClient; ops: any; engine: ExecutionEngine;
  engineB: ExecutionEngine; close: () => Promise<void>;
}> {
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const pg = new PgClient();
  await pg.connect(url);
  await bootstrapPgSchema(pg);  // idempotent; schema may already exist
  const asyncDb = new PgAsyncEngine(pg);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  const engineB = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  return {
    pg,
    ops: (store as any).recoveryOpsAsync,
    engine,
    engineB,
    close: async () => { try { await pg.close(); } catch {} try { mem.close(); } catch {} },
  };
}

async function main() {
  console.log("=== Phase 270B - PostgreSQL Shutdown / Reconciliation Integrity ===\n");

  const safety = checkSafety();
  if (!safety.ok) {
    console.log("[BLOCKED] " + safety.reason);
    process.exit(0);
  }
  const url = process.env.DATABASE_URL!;

  // S1: Post-shutdown reconciliation no-op
  section("Sc270B-1 [SHUTDOWN GUARD] reconcile no-ops after markShuttingDown");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s1");
      // Create a job in PG so reconcile finds it (if it runs)
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;

      ok(h.engine.isShuttingDown() === false, "Sc270B-1 initial: not shutting down");
      h.engine.markShuttingDown();
      ok(h.engine.isShuttingDown() === true, "Sc270B-1 flag set");

      await h.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const after = await h.ops.getOperation(opId);
      ok(after.state === "PENDING", "Sc270B-1 op PENDING after shutdown reconcile", "got=" + after.state);
      ok(after.claimOwner == null, "Sc270B-1 no claim owner", "got=" + after.claimOwner);
    } finally { await h.close(); }
  }

  // S2: Shutdown idempotency
  section("Sc270B-2 [SHUTDOWN GUARD] repeated shutdown + reconcile idempotent");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s2");
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;

      for (let i = 0; i < 3; i++) {
        h.engine.markShuttingDown();
        await h.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      }
      const after = await h.ops.getOperation(opId);
      ok(after.state === "PENDING", "Sc270B-2 state unchanged across cycles", "got=" + after.state);
      ok(after.claimOwner == null, "Sc270B-2 no claim owner assigned");
    } finally { await h.close(); }
  }

  // S3: Pre-shutdown reconciliation control — MUST actually reconcile
  section("Sc270B-3 [CONTROL] pre-shutdown reconcile actually executes recovery path");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s3");
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'QUEUED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;

      // NOT shutting down — reconcile should run
      ok(h.engine.isShuttingDown() === false, "Sc270B-3 not shutting down");
      await h.engine.reconcileExecutionRecoveryOperations(1_000_000, Infinity);
      const after = await h.ops.getOperation(opId);
      // Job was QUEUED → ORPHAN_RECOVERY branch calls finalizeCompletedOperation
      ok(after.state === "COMPLETED", "Sc270B-3 op WAS reconciled (job QUEUED → COMPLETED)",
         "got=" + after.state);
    } finally { await h.close(); }
  }

  // S4: Durability across connections
  section("Sc270B-4 [DURABILITY] state written via one connection read via another");
  {
    const jobId = uniq("s4");
    let opId: string;
    const h1 = await openStore(url);
    try {
      await h1.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h1.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      opId = c.operation.operationId;
    } finally { await h1.close(); }

    const h2 = await openStore(url);
    try {
      const op = await h2.ops.getOperation(opId!);
      ok(!!op, "Sc270B-4 op readable via second connection");
      ok(op.state === "PENDING", "Sc270B-4 state preserved", "got=" + op?.state);
    } finally { await h2.close(); }
  }

  // S5: No false completion on shutdown path
  section("Sc270B-5 [SHUTDOWN GUARD] shutdown path does not falsely COMPLETE");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s5");
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      h.engine.markShuttingDown();
      await h.engine.reconcileExecutionRecoveryOperations(2_000_000, Infinity);
      const after = await h.ops.getOperation(opId);
      ok(after.state !== "COMPLETED", "Sc270B-5 not falsely COMPLETED", "got=" + after.state);
      ok(after.completedAt == null, "Sc270B-5 completed_at not set");
    } finally { await h.close(); }
  }

  // S6: Claim ownership integrity
  section("Sc270B-6 [OWNERSHIP] stale owner cannot finalize after reclaim");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s6");
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await h.ops.claimOperation({ operationId: opId, owner: "owner-a", durationMs: 1000, now: 1000 });
      const r = await h.ops.claimOperation({ operationId: opId, owner: "owner-b", durationMs: 60000, now: 2000 });
      ok(r.claimed === true, "Sc270B-6 owner-b reclaimed after TTL");
      const stale = await h.ops.markCompleted(opId, "owner-a", Date.now());
      ok(stale === false, "Sc270B-6 stale owner-a cannot finalize", "got=" + stale);
    } finally { await h.close(); }
  }

  // S7: Error honesty
  section("Sc270B-7 [ERROR HONESTY] closed connection error surfaces, not success");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s7");
      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      const opId = c.operation.operationId;
      await h.ops.claimOperation({ operationId: opId, owner: "owner-a", durationMs: 60000, now: 1000 });
      await h.pg.close();
      let threw = false, returnedSuccess = false;
      try {
        const r = await Promise.race([
          h.ops.markCompleted(opId, "owner-a", Date.now()),
          new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
        ]);
        returnedSuccess = r === true;
      } catch { threw = true; }
      ok(threw || !returnedSuccess, "Sc270B-7 error surfaced", "threw=" + threw + " success=" + returnedSuccess);
    } finally { try { await h.close(); } catch {} }
  }

  // S8: Isolation (unique IDs, no unrelated mutation)
  section("Sc270B-8 [ISOLATION] unique identifiers, no unrelated rows touched");
  {
    const h = await openStore(url);
    try {
      const jobId = uniq("s8");
      const beforeCount: any = await h.pg.query(
        "SELECT COUNT(*)::text AS c FROM execution_recovery_operations WHERE job_id = $1", [jobId]
      );
      const beforeN = Number((beforeCount?.rows ?? beforeCount)?.[0]?.c ?? 0);
      ok(beforeN === 0, "Sc270B-8 no pre-existing rows for unique jobId", "count=" + beforeN);

      await h.pg.query(
        `INSERT INTO execution_jobs (id, idempotency_key, job_type, status, created_at, updated_at)
         VALUES ($1, $2, 'EXECUTION', 'ORPHANED', $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, "idem-" + jobId, Date.now()],
      );
      const c = await h.ops.createOrGetOperation({
        jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1,
      });
      ok(!!c.operation.operationId, "Sc270B-8 op created");

      const afterCount: any = await h.pg.query(
        "SELECT COUNT(*)::text AS c FROM execution_recovery_operations WHERE job_id = $1", [jobId]
      );
      const afterN = Number((afterCount?.rows ?? afterCount)?.[0]?.c ?? 0);
      ok(afterN === 1, "Sc270B-8 exactly one op for unique jobId", "count=" + afterN);
    } finally { await h.close(); }
  }

  console.log("\n============================================");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(2); });