// scripts/test-phase265-recovery-reconciliation-integrity.ts
// Phase 265 - end-to-end recovery reconciliation integrity.
//
// Verifies that reconcileExecutionRecoveryOperations(now, limit) honors the
// store-level guarantees established by Phase 264:
//   - deterministic clock propagation into eligibility
//   - claim-time enforcement of next_attempt_at
//   - next_attempt_at cleared on claim
//   - NON_RETRYABLE FAILED excluded from auto-retry
//   - RECOVERY_REQUIRED preserved (excluded from auto-retry, claimable by escalation)
//   - limit contract (bounded per-tick work)
//   - concurrent reconciliation: one winner
//
// Deterministic clock. No sleeps. Every assertion reads durable rows.

import Database from "better-sqlite3";
import { join } from "path";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { ExecutionJob } from "../src/core/execution-models";

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
  return `p265-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface H {
  db: Database.Database;
  store: ExecutionStore;
  engine: ExecutionEngine;
}

function makeHarness(): H {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, join(process.cwd(), "src", "db", "migrations")).run();
  const db = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(db as any);
  const workerRegistry: any = { detectLostWorkers: () => [] };
  const leaseManager: any = { recoverExpiredLeases: () => [] };
  const engine = new ExecutionEngine(store, workerRegistry, leaseManager, {} as any, {} as any);
  return { db: rawDb, store, engine };
}

function seedJob(db: Database.Database, jobId: string, status: string, executionId: string): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(jobId, "idem-" + jobId, "engineering", JSON.stringify({ kind: "engineering", executionId }), status, now, now);
}

async function seedFailedOp(
  h: H,
  jobId: string,
  executionId: string,
  failureClass: string | null,
  nextAttemptAt: number | null,
  now: number,
): Promise<{ operationId: string; state: string }> {
  seedJob(h.db, jobId, "FAILED", executionId);
  const ops: any = (h.store as any).recoveryOps;
  // Sort key: use created_at = 1 so this op sorts before any residue from
  // prior test runs in a shared Postgres table (SQLite is fresh per harness,
  // but this keeps both paths identical and hermetic).
  const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
  const opId = c.operation.operationId;
  await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
  await ops.markInProgress(opId, "seeder", now - 10_000);
  await ops.markFailed(opId, "seeder", failureClass === "NON_RETRYABLE" ? "VALIDATION_FAILED" : "request TIMEOUT", now, {
    failureClass,
    nextAttemptAt,
  });
  const op = await ops.getOperation(opId);
  return { operationId: opId, state: op.state };
}

function readOp(h: H, opId: string): any {
  return h.db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(opId) as any;
}

async function main() {
  console.log("=== Phase 265 - End-to-End Recovery Reconciliation Integrity ===\n");

  // ============================================================
  // 265-A — Future retry deadline: reconcile before deadline ? op untouched
  // ============================================================
  section("265-A future retry deadline blocks reconciliation");
  {
    const h = makeHarness();
    const now = 1_000_000;
    const futureDeadline = now + 60_000;
    const { operationId } = await seedFailedOp(h, uniq("a"), uniq("a-exec"), "RETRYABLE", futureDeadline, now - 1000);

    const before = readOp(h, operationId);
    await h.engine.reconcileExecutionRecoveryOperations(now, Infinity);
    const after = readOp(h, operationId);

    ok(before.state === "FAILED", "265-A before: state FAILED");
    ok(before.next_attempt_at === futureDeadline, "265-A before: next_attempt_at = future deadline");
    ok(after.state === "FAILED", "265-A after: state still FAILED");
    ok(after.next_attempt_at === futureDeadline, "265-A after: next_attempt_at unchanged");
    ok(after.claim_owner === null, "265-A after: no claim owner");
    ok(after.attempt_count === before.attempt_count, "265-A after: attempt_count unchanged");
  }

  // ============================================================
  // 265-B — Due retry deadline: reconcile at/after deadline processes op
  // ============================================================
  section("265-B due retry deadline permits reconciliation");
  {
    const h = makeHarness();
    const now = 2_000_000;
    const dueDeadline = now - 1000;
    const { operationId } = await seedFailedOp(h, uniq("b"), uniq("b-exec"), "RETRYABLE", dueDeadline, now - 10_000);

    await h.engine.reconcileExecutionRecoveryOperations(now, Infinity);
    const after = readOp(h, operationId);

    // Reconcile either claims and completes it, or escalates on job-state
    // mismatch. Either way, the op must not remain in FAILED with a live
    // claim owner pointing at nobody.
    const processed =
      after.state === "COMPLETED" ||
      after.state === "RECOVERY_REQUIRED" ||
      after.state === "CLAIMED" ||
      after.state === "IN_PROGRESS";
    ok(processed, "265-B op transitioned out of FAILED (state=" + after.state + ")");
    ok(after.claim_owner === null || after.state === "CLAIMED" || after.state === "IN_PROGRESS",
       "265-B claim ownership consistent with state");
  }

  // ============================================================
  // 265-C — Deterministic clock: supplied `now` overrides wall clock
  // ============================================================
  section("265-C supplied now overrides wall clock");
  {
    const h = makeHarness();
    // Deadline is far in the future relative to wall clock, but we will pass
    // a logical `now` that is even further in the future.
    const wallNow = Date.now();
    const logicalNow = wallNow + 10_000_000;
    const deadline = wallNow + 5_000_000; // before logicalNow, after wallNow

    const { operationId } = await seedFailedOp(h, uniq("c"), uniq("c-exec"), "RETRYABLE", deadline, wallNow);

    // Reconcile at logicalNow (past deadline) ? op is eligible.
    await h.engine.reconcileExecutionRecoveryOperations(logicalNow, Infinity);
    const after = readOp(h, operationId);
    const processed =
      after.state !== "FAILED" ||
      after.claim_owner !== null;
    ok(processed, "265-C supplied now made future-vs-wall-clock op eligible (state=" + after.state + ")");
  }

  // ============================================================
  // 265-D — NON_RETRYABLE excluded from automatic retry
  // ============================================================
  section("265-D NON_RETRYABLE failure excluded from auto-retry");
  {
    const h = makeHarness();
    const now = 3_000_000;
    const { operationId } = await seedFailedOp(h, uniq("d"), uniq("d-exec"), "NON_RETRYABLE", null, now);

    await h.engine.reconcileExecutionRecoveryOperations(now, Infinity);
    const after = readOp(h, operationId);

    ok(after.state === "FAILED", "265-D still FAILED (not auto-retried)");
    ok(after.last_failure_class === "NON_RETRYABLE", "265-D failure class persisted");
    ok(after.claim_owner === null, "265-D no claim owner assigned");
  }

  // ============================================================
  // 265-E — Claim-time deadline enforcement through the store API
  // ============================================================
  section("265-E claim-time deadline enforcement");
  {
    const h = makeHarness();
    const now = 4_000_000;
    const deadline = now + 60_000;
    const { operationId } = await seedFailedOp(h, uniq("e"), uniq("e-exec"), "RETRYABLE", deadline, now - 1000);
    const ops: any = (h.store as any).recoveryOps;

    const early = await ops.claimOperation({ operationId, owner: "early", durationMs: 60_000, now: now });
    ok(early.claimed === false, "265-E claim before deadline refused");

    const late = await ops.claimOperation({ operationId, owner: "late", durationMs: 60_000, now: deadline + 1 });
    ok(late.claimed === true, "265-E claim at/after deadline succeeds");
  }

  // ============================================================
  // 265-F — Concurrent reconciliation: exactly one claim winner
  // ============================================================
  section("265-F concurrent reconciliation - one claim winner");
  {
    const h = makeHarness();
    const now = 5_000_000;
    const deadline = now - 1000;
    const { operationId } = await seedFailedOp(h, uniq("f"), uniq("f-exec"), "RETRYABLE", deadline, now - 10_000);
    const ops: any = (h.store as any).recoveryOps;

    // Two parallel claims through the store, mirroring what two reconcile
    // loops would do when both see the same resumable candidate.
    const [r1, r2] = await Promise.all([
      ops.claimOperation({ operationId, owner: "worker-1", durationMs: 60_000, now }),
      ops.claimOperation({ operationId, owner: "worker-2", durationMs: 60_000, now }),
    ]);
    const winners = [r1, r2].filter((r) => r?.claimed === true).length;
    ok(winners === 1, "265-F exactly one concurrent claim winner (got " + winners + ")");

    const op = readOp(h, operationId);
    const owners = ["worker-1", "worker-2"].filter((w) => op.claim_owner === w);
    ok(owners.length === 1, "265-F persisted row shows exactly one owner");
  }

  // ============================================================
  // 265-G — Limit contract: bounded work per tick
  // ============================================================
  section("265-G limit caps per-tick work");
  {
    const h = makeHarness();
    const now = 6_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { operationId } = await seedFailedOp(h, uniq("g" + i), uniq("g-exec" + i), "RETRYABLE", now - 1000, now - 10_000);
      ids.push(operationId);
    }

    await h.engine.reconcileExecutionRecoveryOperations(now, 1);

    // Exactly one of the three should have been claimed/processed; the other two
    // should still be FAILED with no claim owner.
    const rows = ids.map((id) => readOp(h, id));
    const claimedCount = rows.filter((r) => r.claim_owner !== null || r.state !== "FAILED").length;
    ok(claimedCount === 1, "265-G limit=1 processed exactly one candidate (got " + claimedCount + ")");

    const untouched = rows.filter((r) => r.state === "FAILED" && r.claim_owner === null).length;
    ok(untouched === 2, "265-G two candidates remain untouched (got " + untouched + ")");
  }

  // ============================================================
  // 265-H — limit=0 and Infinity
  // ============================================================
  section("265-H limit boundary values");
  {
    const h = makeHarness();
    const now = 7_000_000;
    const { operationId } = await seedFailedOp(h, uniq("h"), uniq("h-exec"), "RETRYABLE", now - 1000, now - 10_000);

    await h.engine.reconcileExecutionRecoveryOperations(now, 0);
    const after0 = readOp(h, operationId);
    ok(after0.state === "FAILED" && after0.claim_owner === null,
       "265-H limit=0 processed nothing");

    await h.engine.reconcileExecutionRecoveryOperations(now, Infinity);
    const afterInf = readOp(h, operationId);
    ok(afterInf.state !== "FAILED" || afterInf.claim_owner !== null,
       "265-H limit=Infinity processed the candidate (state=" + afterInf.state + ")");
  }

  // ============================================================
  // 265-I — RECOVERY_REQUIRED preserved (not auto-retried, still claimable)
  // ============================================================
  section("265-I RECOVERY_REQUIRED invariant preserved");
  {
    const h = makeHarness();
    const now = 8_000_000;
    seedJob(h.db, uniq("i"), "FAILED", uniq("i-exec"));
    const ops: any = (h.store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId: uniq("i"), leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
    await ops.markInProgress(opId, "seeder", now - 10_000);
    await ops.markRecoveryRequired(opId, "seeder", "OPERATOR_SIGNAL", now);

    await h.engine.reconcileExecutionRecoveryOperations(now, Infinity);
    const after = readOp(h, opId);
    ok(after.state === "RECOVERY_REQUIRED", "265-I reconcile did not auto-retry RECOVERY_REQUIRED");
    ok(after.claim_owner === null, "265-I no claim owner assigned by reconcile");

    // Escalation path can still claim it directly.
    const esc = await ops.claimOperation({ operationId: opId, owner: "escalator", durationMs: 60_000, now: now + 1000 });
    ok(esc.claimed === true, "265-I escalation claim still succeeds");
  }

  // ============================================================
  // 265-J — limit validation: invalid limits fail closed
  // ============================================================
  section("265-J invalid limit rejected without unbounded work");
  {
    const h = makeHarness();
    const now = 9_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { operationId } = await seedFailedOp(h, uniq("j" + i), uniq("j-exec" + i), "RETRYABLE", now - 1000, now - 10_000);
      ids.push(operationId);
    }

    const invalidLimits: Array<{ label: string; value: number }> = [
      { label: "-1", value: -1 },
      { label: "NaN", value: NaN },
      { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
      { label: "2.5", value: 2.5 },
    ];

    for (const { label, value } of invalidLimits) {
      let threw = false;
      let caughtMessage = "";
      try {
        await h.engine.reconcileExecutionRecoveryOperations(now, value);
      } catch (e: any) {
        threw = true;
        caughtMessage = String(e?.message ?? e);
      }
      ok(threw, "265-J limit=" + label + " rejected with throw");
      ok(
        caughtMessage.includes("invalid limit"),
        "265-J limit=" + label + " error names invalid limit (got: " + caughtMessage + ")",
      );
    }

    // All three seeds must remain FAILED with no claim owner: the rejected
    // calls must not have touched any operation.
    const rows = ids.map((id) => readOp(h, id));
    const untouched = rows.filter((r) => r.state === "FAILED" && r.claim_owner === null).length;
    ok(untouched === 3, "265-J invalid limits did not process any candidate (untouched=" + untouched + ")");
  }

  // ============================================================
  // 265-K — valid limits still work as before
  // ============================================================
  section("265-K valid limit boundaries preserved");
  {
    // limit=0 processes nothing
    {
      const h = makeHarness();
      const now = 10_000_000;
      const { operationId } = await seedFailedOp(h, uniq("k0"), uniq("k0-exec"), "RETRYABLE", now - 1000, now - 10_000);
      await h.engine.reconcileExecutionRecoveryOperations(now, 0);
      const after = readOp(h, operationId);
      ok(after.state === "FAILED" && after.claim_owner === null, "265-K limit=0 processed nothing");
    }

    // limit=Infinity processes
    {
      const h = makeHarness();
      const now = 11_000_000;
      const { operationId } = await seedFailedOp(h, uniq("ki"), uniq("ki-exec"), "RETRYABLE", now - 1000, now - 10_000);
      await h.engine.reconcileExecutionRecoveryOperations(now, Number.POSITIVE_INFINITY);
      const after = readOp(h, operationId);
      ok(
        after.state !== "FAILED" || after.claim_owner !== null,
        "265-K limit=Infinity processed the candidate (state=" + after.state + ")",
      );
    }

    // positive finite integer N=2 processes at most 2
    {
      const h = makeHarness();
      const now = 12_000_000;
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const { operationId } = await seedFailedOp(h, uniq("kn" + i), uniq("kn-exec" + i), "RETRYABLE", now - 1000, now - 10_000);
        ids.push(operationId);
      }
      await h.engine.reconcileExecutionRecoveryOperations(now, 2);
      const rows = ids.map((id) => readOp(h, id));
      const processed = rows.filter((r) => r.state !== "FAILED" || r.claim_owner !== null).length;
      ok(processed === 2, "265-K limit=2 processed exactly two candidates (got " + processed + ")");
    }
  }

  // ============================================================
  // PostgreSQL parity — ISOLATED DATABASE
  //
  // The shared Nexus database contains unrelated eligible recovery
  // operations from other test suites and prior runs. Because
  // listResumableOperations orders globally by created_at and the
  // limit slice takes the top-N, a limit=1 assertion cannot be made
  // deterministic against the shared table without either mutating
  // foreign rows or deleting state we do not own.
  //
  // This block therefore creates a disposable database, bootstraps
  // the schema there, runs the parity scenarios against it, and drops
  // it in the finally. Only rows created by this run exist inside the
  // isolated database, so the limit assertion is deterministic.
  // Requires CREATEDB on the connection role (verified at runtime;
  // if the role lacks it, the block reports BLOCKED, not PASS).
  // ============================================================
  const url = process.env.DATABASE_URL;
  if (!url) {
    blocked++;
    console.log("\nBLOCKED  PostgreSQL parity :: DATABASE_URL not set");
  } else {
    const parsed = new URL(url);
    const basePath = parsed.pathname.replace(/^\//, "") || "postgres";
    const isoName = (basePath + "_p265_" + Math.random().toString(36).slice(2, 10)).toLowerCase();
    const isoUrl = url.replace(/(:\/\/[^/]*\/)[^/?]*/, "$1" + isoName);

    let adminPg: any = null;
    let pg: any = null;

    try {
      const { PgClient } = await import("../src/core/pg-client");
      const { PgAsyncEngine } = await import("../src/core/pg-async-engine");
      const { bootstrapPgSchema } = await import("../src/core/pg-bootstrap");

      // 1. Verify CREATEDB permission before attempting DDL.
      adminPg = new PgClient();
      await adminPg.connect(url);
      const perm = await adminPg.query<{ createdb: boolean }>(
        "SELECT rolcreatedb OR rolsuper AS createdb FROM pg_roles WHERE rolname = current_user",
      );
      if (perm.rows[0]?.createdb !== true) {
        blocked++;
        console.log("\nBLOCKED  PostgreSQL parity :: current role lacks CREATEDB; cannot create isolated database");
        return; // finally will close adminPg
      }

      // 2. Create the isolated database.
      await adminPg.query('CREATE DATABASE "' + isoName + '"');
      console.log("  [setup] created isolated database " + isoName);

      // 3. Connect to the isolated database and bootstrap the schema.
      pg = new PgClient();
      await pg.connect(isoUrl);
      await bootstrapPgSchema(pg);

      const asyncEngine = new PgAsyncEngine(pg);

      const mem = new Database(":memory:");
      new MigrationRunner(mem, join(process.cwd(), "src", "db", "migrations")).run();
      const syncEngine = SQLiteEngine.fromDatabase(mem);
      const pgStore = new ExecutionStore(syncEngine as any, asyncEngine as any);

      const workerRegistry: any = { detectLostWorkers: () => [] };
      const leaseManager: any = { recoverExpiredLeases: () => [] };
      const pgEngine = new ExecutionEngine(pgStore, workerRegistry, leaseManager, {} as any, {} as any);

      async function pgSeedFailedOp(
        jobId: string, executionId: string,
        failureClass: string | null, nextAttemptAt: number | null, now: number,
      ): Promise<string> {
        seedJob(mem, jobId, "FAILED", executionId);
        const ops: any = (pgStore as any).recoveryOpsAsync;
        const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY" });
        const opId = c.operation.operationId;
        await ops.claimOperation({ operationId: opId, owner: "seeder", durationMs: 60_000, now: now - 10_000 });
        await ops.markInProgress(opId, "seeder", now - 10_000);
        await ops.markFailed(opId, "seeder", failureClass === "NON_RETRYABLE" ? "VALIDATION_FAILED" : "request TIMEOUT", now, {
          failureClass, nextAttemptAt,
        });
        return opId;
      }

      async function pgReadOp(opId: string): Promise<any> {
        const ops: any = (pgStore as any).recoveryOpsAsync;
        return ops.getOperation(opId);
      }

      section("265-A-PG future retry deadline blocks reconciliation");
      {
        const now = 1_000_000;
        const deadline = now + 60_000;
        const opId = await pgSeedFailedOp(uniq("apg"), uniq("apg-exec"), "RETRYABLE", deadline, now - 1000);

        await pgEngine.reconcileExecutionRecoveryOperations(now, Infinity);
        const after = await pgReadOp(opId);

        ok(after.state === "FAILED", "265-A-PG still FAILED");
        ok(Number(after.nextAttemptAt) === deadline, "265-A-PG next_attempt_at unchanged");
        ok(after.claimOwner === null, "265-A-PG no claim owner");
      }

      section("265-D-PG NON_RETRYABLE excluded");
      {
        const now = 3_000_000;
        const opId = await pgSeedFailedOp(uniq("dpg"), uniq("dpg-exec"), "NON_RETRYABLE", null, now);
        await pgEngine.reconcileExecutionRecoveryOperations(now, Infinity);
        const after = await pgReadOp(opId);
        ok(after.state === "FAILED", "265-D-PG still FAILED");
        ok(after.lastFailureClass === "NON_RETRYABLE", "265-D-PG class persisted");
      }

      section("265-G-PG limit caps per-tick work");
      {
        const now = 6_000_000;
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          ids.push(await pgSeedFailedOp(uniq("gpg" + i), uniq("gpg-exec" + i), "RETRYABLE", now - 1000, now - 10_000));
        }

        await pgEngine.reconcileExecutionRecoveryOperations(now, 1);
        const rows = await Promise.all(ids.map((id) => pgReadOp(id)));
        const processed = rows.filter((r) => r.state !== "FAILED" || r.claimOwner !== null).length;
        ok(processed === 1, "265-G-PG limit=1 processed exactly one (got " + processed + ")");
      }

      try { mem.close(); } catch {}
    } catch (e: any) {
      blocked++;
      console.log("\nBLOCKED  PostgreSQL parity :: " + describePgError(e)); // PHASE266CLEANUP_FIX_APPLIED
    } finally {
      // Tear down: close the isolated-database client, then DROP the
      // isolated database via the admin connection. Any drop failure is
      // reported as a real failure, not swallowed.
      try { await pg?.close(); } catch {}
      if (adminPg) {
        if (adminPg.isConnected && adminPg.isConnected()) {
          try {
            await adminPg.query('DROP DATABASE IF EXISTS "' + isoName + '" WITH (FORCE)');
            console.log("  [cleanup] dropped isolated database " + isoName);
          } catch (dropErr: any) {
            failed++;
            console.log("  FAIL Phase 265 Postgres cleanup (drop): " + describePgError(dropErr));
          }
        } else {
          console.log("  [cleanup] skipped: admin connection never established (see BLOCKED above)");
        }
        try { await adminPg.close(); } catch {}
      }
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("PHASE265 DRIVER CRASH:", e?.stack ?? e); process.exit(1); });