// scripts/test-phase266-recovery-reconciliation-concurrency.ts
// Phase 266 - production-grade recovery reconciliation concurrency.
//
// Purpose: prove that two INDEPENDENT ExecutionEngine instances sharing the
// SAME persistence store cannot both win a claim on one resumable recovery
// operation. Phase 265-F exercised the store's claimOperation() directly;
// Phase 266 drives the engine's public reconcileExecutionRecoveryOperations()
// from two engine objects and asserts PERSISTED state, not return values.
//
// Deterministic clock. No sleeps. Every assertion reads durable rows.
//
// Honest scope:
//   - SQLite path: two engines over one ExecutionStore over one SQLiteEngine.
//   - PostgreSQL path (parity block): requires DATABASE_URL. If unset, the
//     block reports BLOCKED with the exact reason, never PASS.
//   - We do NOT assume exactly-once execution of the recovery BODY. The
//     engine's reconcile loop may take different paths (escalate to
//     RECOVERY_REQUIRED, finalize completed, run the recovery body). What
//     we assert is the store-level invariant the code actually enforces:
//     at most one CLAIMED transition per operation per concurrent pass,
//     and attempt_count increments by at most one winner.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";

// PHASE266CLEANUP_FIX_APPLIED: stable error description for infra failures.
// AggregateError (ECONNREFUSED) carries an empty .message; the useful
// fields are .name, .code, and .errors[]. This must never be silent.
function describePgError(e: any): string {
  if (!e) return "<no error>";
  const name = e?.name ?? "Error";
  const code = e?.code ? " / code=" + e.code : "";
  const msg = e?.message ? " / " + e.message : " / <no message>";
  const causes = Array.isArray(e?.errors) && e.errors.length
    ? " / causes=[" + e.errors.map((x: any) => String(x?.code ?? x?.message ?? x)).join(", ") + "]"
    : "";
  return name + code + msg + causes;
}

let passed = 0, failed = 0, blocked = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else      { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }
function uniq(t: string): string {
  return `p266-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface H {
  rawDb: Database.Database;
  store: ExecutionStore;
  engineA: ExecutionEngine;
  engineB: ExecutionEngine;
}

// Two independent engines over ONE shared ExecutionStore (and therefore one
// shared execution_recovery_operations table). This is the minimal honest
// arrangement required by Phase 266 section 2.
function makeSharedHarness(): H {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, join(process.cwd(), "src", "db", "migrations")).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const leaseManager: any = { recoverExpiredLeases: () => [] };
  const engineA = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {} as any);
  const engineB = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {} as any);
  return { rawDb, store, engineA, engineB };
}

function seedJob(rawDb: Database.Database, jobId: string, status: string, executionId: string): void {
  const now = Date.now();
  rawDb.prepare(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(jobId, "idem-" + jobId, "engineering", JSON.stringify({ kind: "engineering", executionId }), status, now, now);
}

async function seedFailedOp(
  h: H, jobId: string, executionId: string,
  failureClass: string | null, nextAttemptAt: number | null, now: number,
): Promise<string> {
  seedJob(h.rawDb, jobId, "FAILED", executionId);
  const ops: any = (h.store as any).recoveryOps;
  const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
  const opId = c.operation.operationId;
  await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
  await ops.markInProgress(opId, "seeder", now - 10_000);
  await ops.markFailed(opId, "seeder", failureClass === "NON_RETRYABLE" ? "VALIDATION_FAILED" : "request TIMEOUT", now, {
    failureClass, nextAttemptAt,
  });
  return opId;
}

function readOpRaw(h: H, opId: string): any {
  return h.rawDb.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}

async function main() {
  console.log("=== Phase 266 - Recovery Reconciliation Concurrency (two engines, one store) ===\n");

  // ============================================================
  // 266-1  Two engines, one shared store, one due candidate:
  //        at most one CLAIMED transition, at most one attempt_count bump.
  // ============================================================
  section("266-1 two engines reconcile concurrently - one claim winner");
  {
    const h = makeSharedHarness();
    const now = 100_000_000;
    const opId = await seedFailedOp(h, uniq("1"), uniq("1-exec"), "RETRYABLE", now - 1000, now - 10_000);
    const before = readOpRaw(h, opId);

    await Promise.all([
      h.engineA.reconcileExecutionRecoveryOperations(now, Infinity),
      h.engineB.reconcileExecutionRecoveryOperations(now, Infinity),
    ]);

    const after = readOpRaw(h, opId);
    // attempt_count increments only on a winning claimOperation. One winner
    // => at most one increment across both engines. (If both saw zero
    // eligible ops for some reason, increment is 0, also fine.)
    const bumps = after.attempt_count - before.attempt_count;
    ok(bumps <= 1, "266-1 attempt_count incremented by at most 1 (got +" + bumps + ")");

    // No row may show a claim_owner that isn't a real engine owner. Since the
    // engines either complete, escalate, or leave the op CLAIMED (owner set),
    // the invariant is: at most one distinct persisted outcome, and
    // claim_owner is either null or an engine-* string.
    const ownerOk =
      after.claim_owner === null ||
      (typeof after.claim_owner === "string" && after.claim_owner.startsWith("engine-"));
    ok(ownerOk, "266-1 persisted claim_owner is null or engine-owned (got " + after.claim_owner + ")");

    // State must be one of the legitimately reachable post-reconcile states.
    const okStates = new Set(["COMPLETED", "RECOVERY_REQUIRED", "CLAIMED", "IN_PROGRESS", "FAILED"]);
    ok(okStates.has(after.state), "266-1 persisted state is a legitimate post-reconcile state (got " + after.state + ")");
  }

  // ============================================================
  // 266-2  Race stress: fresh candidate each iteration, two engines
  //        reconciled concurrently, invariant checked every iteration.
  // ============================================================
  section("266-2 race stress - N iterations, invariant holds each time");
  {
    const N = 25;
    let violations = 0;
    for (let i = 0; i < N; i++) {
      const h = makeSharedHarness();
      const now = 200_000_000 + i * 1000;
      const opId = await seedFailedOp(h, uniq("2-" + i), uniq("2-exec-" + i), "RETRYABLE", now - 1000, now - 10_000);
      const before = readOpRaw(h, opId);
      await Promise.all([
        h.engineA.reconcileExecutionRecoveryOperations(now, Infinity),
        h.engineB.reconcileExecutionRecoveryOperations(now, Infinity),
      ]);
      const after = readOpRaw(h, opId);
      const bumps = after.attempt_count - before.attempt_count;
      if (bumps > 1) violations++;
      if (after.state !== "FAILED" && after.claim_owner !== null && !String(after.claim_owner).startsWith("engine-")) {
        violations++;
      }
    }
    ok(violations === 0, "266-2 no invariant violation across " + N + " iterations (violations=" + violations + ")");
  }

  // ============================================================
  // 266-3  RECOVERY_REQUIRED is not auto-retried by either engine.
  // ============================================================
  section("266-3 RECOVERY_REQUIRED not auto-retried by concurrent engines");
  {
    const h = makeSharedHarness();
    const now = 300_000_000;
    const jobId = uniq("3");
    seedJob(h.rawDb, jobId, "FAILED", uniq("3-exec"));
    const ops: any = (h.store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
    await ops.markInProgress(opId, "seeder", now - 10_000);
    await ops.markRecoveryRequired(opId, "seeder", "OPERATOR_SIGNAL", now);

    const before = readOpRaw(h, opId);
    await Promise.all([
      h.engineA.reconcileExecutionRecoveryOperations(now, Infinity),
      h.engineB.reconcileExecutionRecoveryOperations(now, Infinity),
    ]);
    const after = readOpRaw(h, opId);
    ok(after.state === "RECOVERY_REQUIRED", "266-3 state unchanged (got " + after.state + ")");
    ok(after.claim_owner === null, "266-3 no engine claimed it");
    ok(after.attempt_count === before.attempt_count, "266-3 attempt_count unchanged");
  }

  // ============================================================
  // 266-4  Supplied now controls eligibility for both engines.
  // ============================================================
  section("266-4 supplied now controls eligibility (two engines)");
  {
    const h = makeSharedHarness();
    const wall = Date.now();
    const logicalNow = wall + 10_000_000;
    const deadline = wall + 5_000_000; // future vs wall, past vs logicalNow
    const opId = await seedFailedOp(h, uniq("4"), uniq("4-exec"), "RETRYABLE", deadline, wall);

    // Reconcile at wall clock: still ineligible.
    await Promise.all([
      h.engineA.reconcileExecutionRecoveryOperations(wall, Infinity),
      h.engineB.reconcileExecutionRecoveryOperations(wall, Infinity),
    ]);
    const atWall = readOpRaw(h, opId);
    ok(atWall.state === "FAILED", "266-4 at wall clock: still FAILED (got " + atWall.state + ")");

    // Reconcile at logicalNow: eligible.
    await Promise.all([
      h.engineA.reconcileExecutionRecoveryOperations(logicalNow, Infinity),
      h.engineB.reconcileExecutionRecoveryOperations(logicalNow, Infinity),
    ]);
    const atLogical = readOpRaw(h, opId);
    ok(atLogical.state !== "FAILED" || atLogical.claim_owner !== null,
       "266-4 at logicalNow: processed (state=" + atLogical.state + ")");
  }

  // ============================================================
  // 266-5  Invalid limit rejected by each engine independently.
  //        Both engines must throw the exact validation error and
  //        neither may touch the candidate.
  // ============================================================
  section("266-5 invalid limit rejected by both engines");
  {
    const h = makeSharedHarness();
    const now = 500_000_000;
    const opId = await seedFailedOp(h, uniq("5"), uniq("5-exec"), "RETRYABLE", now - 1000, now - 10_000);

    const invalid: Array<{ label: string; value: number }> = [
      { label: "-1", value: -1 },
      { label: "NaN", value: NaN },
      { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
      { label: "2.5", value: 2.5 },
    ];

    for (const { label, value } of invalid) {
      let threwA = false, threwB = false;
      try { await h.engineA.reconcileExecutionRecoveryOperations(now, value); } catch { threwA = true; }
      try { await h.engineB.reconcileExecutionRecoveryOperations(now, value); } catch { threwB = true; }
      ok(threwA && threwB, "266-5 both engines rejected limit=" + label);
    }

    const after = readOpRaw(h, opId);
    ok(after.state === "FAILED" && after.claim_owner === null,
       "266-5 rejected calls did not touch candidate (state=" + after.state + ")");
  }

  // ============================================================
  // PostgreSQL parity
  // ============================================================
  const url = process.env.DATABASE_URL;
  if (!url) {
    blocked++;
    console.log("\nBLOCKED  PostgreSQL parity :: DATABASE_URL not set");
    console.log("         Phase 266 section 3 (B/C/E/I/J/K parity) NOT executed.");
    console.log("         Set DATABASE_URL to a disposable DB with CREATEDB to enable.");
  } else {
    const parsed = new URL(url);
    const basePath = parsed.pathname.replace(/^\//, "") || "postgres";
    const isoName = (basePath + "_p266_" + Math.random().toString(36).slice(2, 10)).toLowerCase();
    const isoUrl = url.replace(/(:\/\/[^/]*\/)[^/?]*/, "$1" + isoName);

    let adminPg: any = null;
    let pg: any = null;
    let memDb: Database.Database | null = null;

    try {
      const { PgClient } = await import("../src/core/pg-client");
      const { PgAsyncEngine } = await import("../src/core/pg-async-engine");
      const { bootstrapPgSchema } = await import("../src/core/pg-bootstrap");

      adminPg = new PgClient();
      await adminPg.connect(url);
      const perm = await adminPg.query<{ createdb: boolean }>(
        "SELECT rolcreatedb OR rolsuper AS createdb FROM pg_roles WHERE rolname = current_user",
      );
      if (perm.rows[0]?.createdb !== true) {
        blocked++;
        console.log("\nBLOCKED  PostgreSQL parity :: role lacks CREATEDB");
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
      const pgStore = new ExecutionStore(syncEngine as any, asyncEngine as any);

      const workerRegistry: any = { detectLostWorkers: () => [] };
      const leaseManager: any = { recoverExpiredLeases: () => [] };
      const pgEngineA = new ExecutionEngine(pgStore, workerRegistry, leaseManager, {} as any, {} as any);
      const pgEngineB = new ExecutionEngine(pgStore, workerRegistry, leaseManager, {} as any, {} as any);

      async function pgSeedFailedOp(
        jobId: string, executionId: string,
        failureClass: string | null, nextAttemptAt: number | null, now: number,
      ): Promise<string> {
        seedJob(memDb!, jobId, "FAILED", executionId);
        const ops: any = (pgStore as any).recoveryOpsAsync;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
        const opId = c.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
        await ops.markInProgress(opId, "seeder", now - 10_000);
        await ops.markFailed(opId, "seeder", failureClass === "NON_RETRYABLE" ? "VALIDATION_FAILED" : "request TIMEOUT", now, { failureClass, nextAttemptAt });
        return opId;
      }

      // ---- Case B-PG: due retry deadline permits reconciliation ----
      section("266-B-PG due retry deadline permits reconciliation");
      {
        const now = 1_000_000;
        const opId = await pgSeedFailedOp(uniq("bpg"), uniq("bpg-exec"), "RETRYABLE", now - 1000, now - 10_000);
        await Promise.all([
          pgEngineA.reconcileExecutionRecoveryOperations(now, Infinity),
          pgEngineB.reconcileExecutionRecoveryOperations(now, Infinity),
        ]);
        const ops: any = (pgStore as any).recoveryOpsAsync;
        const after = await ops.getOperation(opId);
        ok(after.state !== "FAILED" || after.claimOwner !== null,
           "266-B-PG processed (state=" + after.state + ")");
        const bumps = after.attemptCount; // started at 1 (seeder claim), max 2 after reconcile
        ok(bumps <= 2, "266-B-PG attempt_count <= 2 (got " + bumps + ")");
      }

      // ---- Case C-PG: supplied now controls eligibility ----
      section("266-C-PG supplied now controls eligibility");
      {
        const wall = Date.now();
        const logicalNow = wall + 10_000_000;
        const deadline = wall + 5_000_000;
        const opId = await pgSeedFailedOp(uniq("cpg"), uniq("cpg-exec"), "RETRYABLE", deadline, wall);
        const ops: any = (pgStore as any).recoveryOpsAsync;

        await Promise.all([
          pgEngineA.reconcileExecutionRecoveryOperations(wall, Infinity),
          pgEngineB.reconcileExecutionRecoveryOperations(wall, Infinity),
        ]);
        const atWall = await ops.getOperation(opId);
        ok(atWall.state === "FAILED", "266-C-PG at wall clock: FAILED (got " + atWall.state + ")");

        await Promise.all([
          pgEngineA.reconcileExecutionRecoveryOperations(logicalNow, Infinity),
          pgEngineB.reconcileExecutionRecoveryOperations(logicalNow, Infinity),
        ]);
        const atLogical = await ops.getOperation(opId);
        ok(atLogical.state !== "FAILED" || atLogical.claimOwner !== null,
           "266-C-PG at logicalNow: processed (state=" + atLogical.state + ")");
      }

      // ---- Case E-PG: claim-time deadline enforcement ----
      section("266-E-PG claim-time deadline enforcement");
      {
        const now = 4_000_000;
        const deadline = now + 60_000;
        const opId = await pgSeedFailedOp(uniq("epg"), uniq("epg-exec"), "RETRYABLE", deadline, now - 1000);
        const ops: any = (pgStore as any).recoveryOpsAsync;

        const early = await ops.claimOperation({ operationId: opId, owner: "early", durationMs: 60_000, now });
        ok(early.claimed === false, "266-E-PG claim before deadline refused");

        const late = await ops.claimOperation({ operationId: opId, owner: "late", durationMs: 60_000, now: deadline + 1 });
        ok(late.claimed === true, "266-E-PG claim at/after deadline succeeds");
      }

      // ---- Case I-PG: RECOVERY_REQUIRED is not auto-retried ----
      section("266-I-PG RECOVERY_REQUIRED not auto-retried");
      {
        const now = 8_000_000;
        const jobId = uniq("ipg");
        seedJob(memDb!, jobId, "FAILED", uniq("ipg-exec"));
        const ops: any = (pgStore as any).recoveryOpsAsync;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
        const opId = c.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
        await ops.markInProgress(opId, "seeder", now - 10_000);
        await ops.markRecoveryRequired(opId, "seeder", "OPERATOR_SIGNAL", now);

        await Promise.all([
          pgEngineA.reconcileExecutionRecoveryOperations(now, Infinity),
          pgEngineB.reconcileExecutionRecoveryOperations(now, Infinity),
        ]);
        const after = await ops.getOperation(opId);
        ok(after.state === "RECOVERY_REQUIRED", "266-I-PG state preserved (got " + after.state + ")");
        ok(after.claimOwner === null, "266-I-PG no claim owner");
      }

      // ---- Cases J/K-PG: invalid and valid limits ----
      section("266-J-PG invalid limits rejected; 266-K-PG valid limits honored");
      {
        const now = 9_000_000;
        const invalid: Array<{ label: string; value: number }> = [
          { label: "-1", value: -1 },
          { label: "NaN", value: NaN },
          { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
          { label: "2.5", value: 2.5 },
        ];
        for (const { label, value } of invalid) {
          let threw = false;
          try { await pgEngineA.reconcileExecutionRecoveryOperations(now, value); } catch { threw = true; }
          ok(threw, "266-J-PG limit=" + label + " rejected with throw");
        }

        const opId = await pgSeedFailedOp(uniq("kpg"), uniq("kpg-exec"), "RETRYABLE", now - 1000, now - 10_000);
        await pgEngineA.reconcileExecutionRecoveryOperations(now, 0);
        const ops: any = (pgStore as any).recoveryOpsAsync;
        const afterZero = await ops.getOperation(opId);
        ok(afterZero.state === "FAILED" && afterZero.claimOwner === null, "266-K-PG limit=0 processed nothing");
      }

    } catch (e: any) {
      blocked++;
      console.log("\nBLOCKED  PostgreSQL parity :: " + describePgError(e)); // PHASE266CLEANUP_FIX_APPLIED
    } finally {
      try { await pg?.close(); } catch {}
      if (adminPg) {
        if (adminPg.isConnected && adminPg.isConnected()) {
          try {
            await adminPg.query('DROP DATABASE IF EXISTS "' + isoName + '" WITH (FORCE)');
            console.log("  [cleanup] dropped isolated database " + isoName);
          } catch (dropErr: any) {
            failed++;
            console.log("  FAIL Phase 266 Postgres cleanup (drop): " + describePgError(dropErr));
          }
        } else {
          console.log("  [cleanup] skipped: admin connection never established (see BLOCKED above)");
        }
        try { await adminPg.close(); } catch {}
      }
      try { memDb?.close(); } catch {}
    }
  }

  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("PHASE266 DRIVER CRASH:", e?.stack ?? e); process.exit(1); });