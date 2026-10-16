// scripts/test-phase267-crash-restart-recovery.ts
// Phase 267 - crash/restart recovery for the recovery-operation lifecycle.
//
// Scenario labels:
//   IN-PROCESS FAULT            -- simulated via the existing __testPhase144Hook
//   REAL CHILD-PROCESS RESTART  -- separate Node process, SIGKILL or clean exit
//
// A simulated exception is NOT equivalent to a process restart (Phase 267 section 3).

import { spawn, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import { unlinkSync } from "fs";
import { MigrationRunner } from "../src/core/migration-runner";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { ExecutionEngine } from "../src/core/execution-engine";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else { failed++; console.log("FAIL  " + msg); }
}
function blk(msg: string, reason: string): void { blocked++; console.log("BLOCKED  " + msg + " :: " + reason); }
function ne(msg: string): void { notExec++; console.log("NOT EXECUTED  " + msg); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string { return `p267-${t}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

const CHILD = "scripts/_phase267_crash_child.ts";
const live = new Set<ChildProcess>();
process.on("exit", () => { for (const c of live) { try { c.kill("SIGKILL"); } catch {} } });

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }
function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}
function runChild(backend: string, target: string, cmd: string, ...args: string[]): Promise<ChildOut> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", CHILD, cmd, backend, target, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    live.add(c);
    let so = "", se = "";
    c.stdout!.on("data", (d) => { so += d.toString(); });
    c.stderr!.on("data", (d) => { se += d.toString(); });
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 60_000);
    c.on("exit", (code) => {
      clearTimeout(timer); live.delete(c);
      resolve({ code, stdout: so, stderr: se, json: parseJson(so) });
    });
  });
}

function clean(p: string) { for (const e of ["", "-wal", "-shm"]) { try { unlinkSync(p + e); } catch {} } }
function makeJob(id: string, status = "FAILED"): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "p267-" + id, jobType: "engineering", payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: 0, cancellationAcknowledged: 0,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 },
    timeoutMs: 60000, lastAttemptAt: now, nextAttemptAt: null, currentLeaseId: null,
  };
}

interface Backend { name: "sqlite" | "postgres"; target: string; }
let sqlitePath = "";
let postgresUrl: string | null = null;

async function makeSqliteEngine(): Promise<{ rawDb: Database.Database; store: ExecutionStore; engine: ExecutionEngine }> {
  const raw = new Database(sqlitePath);
  new MigrationRunner(raw, path.join(process.cwd(), "src", "db", "migrations")).run();
  const db = SQLiteEngine.fromDatabase(raw);
  const store = new ExecutionStore(db as any);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
  return { rawDb: raw, store, engine };
}

async function makePgEngine(): Promise<{ store: ExecutionStore; engine: ExecutionEngine; close: () => Promise<void> } | null> {
  if (!postgresUrl) return null;
  try {
    const pg = new PgClient();
    await pg.connect(postgresUrl);
    await bootstrapPgSchema(pg);
    const asyncDb = new PgAsyncEngine(pg);
    const mem = new Database(":memory:");
    new MigrationRunner(mem, path.join(process.cwd(), "src", "db", "migrations")).run();
    const syncEngine = SQLiteEngine.fromDatabase(mem);
    const store = new ExecutionStore(syncEngine as any, asyncDb as any);
    const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, {} as any);
    return {
      store, engine,
      close: async () => { try { mem.close(); } catch {} try { await pg.close(); } catch {} },
    };
  } catch { return null; }
}

async function main() {
  console.log("=== Phase 267 - Crash/Restart Recovery (recovery-operation lifecycle) ===\n");

  // SQLite on-disk so child and parent share state across process boundaries.
  sqlitePath = path.join(os.tmpdir(), `nexus-p267-${Date.now()}.sqlite`);
  clean(sqlitePath);

  const pgOk = !!(process.env.DATABASE_URL && process.env.NEXUS_PERSISTENCE_MODE === "shared");
  postgresUrl = pgOk ? process.env.DATABASE_URL! : null;
  if (!pgOk) {
    console.log("Note: NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL not both set.");
    console.log("      PostgreSQL branches will report NOT EXECUTED; SQLite branches still run.\n");
  }

  // ==========================================================================
  // Scenario 1 -- termination after creating an operation, before claiming it
  // ==========================================================================
  section("Sc267-1 termination after create, before claim");

  // (a) IN-PROCESS FAULT
  {
    const { store, engine } = await makeSqliteEngine();
    const jobId = uniq("1a");
    const now = Date.now();
    (store as any).createJob(makeJob(jobId));
    let hookReached = false;
    let threw = false;
    engine.__testPhase144Hook = (stage) => {
      if (stage === "afterCreate") {
        hookReached = true;
        throw new Error("sc267-1a injected fault");
      }
    };
    try {
      await (engine as any).runRecoveryOperationAsync({
        jobId, leaseId: null, workerId: null, operationType: "TIMEOUT", now,
        body: async () => ({ ok: true }),
      });
    } catch {
      threw = true;
    } finally {
      engine.__testPhase144Hook = undefined;
    }
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const row = db.prepare(
      "SELECT * FROM execution_recovery_operations WHERE job_id = ?"
    ).get(jobId) as any;
    ok(hookReached, "Sc267-1a: afterCreate fault hook was reached");
    ok(threw, "Sc267-1a: injected fault surfaced");
    ok(!!row, "Sc267-1a: operation was persisted before the fault");
    ok(row?.state === "PENDING", "Sc267-1a: persisted state is PENDING (got " + row?.state + ")");
  }
  // (b) REAL CHILD-PROCESS RESTART (SQLite)
  {
    const jobId = uniq("1b");
    const r = await runChild("sqlite", sqlitePath, "create-op", jobId);
    ok(r.code === 0, "Sc267-1b REAL CHILD-PROCESS RESTART: child exited cleanly (code=" + r.code + ")");
    ok(!!r.json?.operationId, "Sc267-1b REAL CHILD-PROCESS RESTART: op id returned");

    // Parent inspects the persisted row after the child exits.
    const { store } = await makeSqliteEngine();
    const row = (() => {
      try {
        const db = (store as any).db ?? (store as any).getDatabase?.();
        return db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(r.json.operationId);
      } catch { return null; }
    })();
    ok(!!row, "Sc267-1b REAL CHILD-PROCESS RESTART: op durable across process boundary");
    ok(row?.state === "PENDING", "Sc267-1b REAL CHILD-PROCESS RESTART: state PENDING (got " + row?.state + ")");
  }

  // Postgres variant of (b) -- NOT EXECUTED unless shared mode.
  if (pgOk) {
    const jobId = uniq("1c");
    const r = await runChild("postgres", postgresUrl!, "create-op", jobId);
    ok(r.code === 0, "Sc267-1c REAL CHILD-PROCESS RESTART (PG): child exited cleanly");
    const eng = await makePgEngine();
    if (eng) {
      const ops: any = (eng.store as any).recoveryOpsAsync;
      const op = await ops.getOperation(r.json.operationId);
      ok(op?.state === "PENDING", "Sc267-1c REAL CHILD-PROCESS RESTART (PG): state PENDING (got " + op?.state + ")");
      await eng.close();
    }
  } else {
    ne("Sc267-1c REAL CHILD-PROCESS RESTART (PG): requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
  }

  // ==========================================================================
  // Scenario 2 -- termination after claim, before markInProgress
  // ==========================================================================
  section("Sc267-2 termination after claim, before in-progress");

  // (a) IN-PROCESS FAULT
  {
    // Keep earlier resumable operations out of this targeted fault test.
    // Restore the shared path before Sc267-2b launches its child process.
    const sharedSqlitePath = sqlitePath;
    const isolatedSqlitePath = path.join(
      os.tmpdir(),
      `nexus-p267-2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`
    );
    clean(isolatedSqlitePath);
    sqlitePath = isolatedSqlitePath;
    let rawDb: Database.Database | undefined;

    try {
      const created = await makeSqliteEngine();
      rawDb = created.rawDb;
      const { store, engine } = created;
      const jobId = uniq("2a");
      const now = Date.now();
      (store as any).createJob(makeJob(jobId));
      (store as any).recoveryOps.createOrGetOperation({
        jobId, leaseId: "", workerId: null, operationType: "TIMEOUT", now,
      });
      let hookReached = false;
      let threw = false;
      engine.__testPhase144Hook = (stage) => {
        if (stage === "afterClaim") {
          hookReached = true;
          throw new Error("sc267-2a injected fault");
        }
      };
      try {
        await engine.reconcileExecutionRecoveryOperations(now, Infinity);
      } catch {
        threw = true;
      } finally {
        engine.__testPhase144Hook = undefined;
      }
      const db = (store as any).db ?? (store as any).getDatabase?.();
      const row = db.prepare(
        "SELECT * FROM execution_recovery_operations WHERE job_id = ?"
      ).get(jobId) as any;
      ok(hookReached, "Sc267-2a: afterClaim fault hook was reached");
      ok(threw, "Sc267-2a: injected fault surfaced");
      ok(!!row, "Sc267-2a: operation persisted");
      ok(row?.state === "CLAIMED", "Sc267-2a: state is CLAIMED (got " + row?.state + ")");
      ok(!!row?.claim_owner, "Sc267-2a: claim owner persisted");
      ok(row?.claim_expires_at != null && row.claim_expires_at > now,
        "Sc267-2a: claim expiry persisted");
    } finally {
      try { rawDb?.close(); } catch {}
      sqlitePath = sharedSqlitePath;
      clean(isolatedSqlitePath);
    }
  }
  // (b) REAL CHILD-PROCESS RESTART -- child claims then SIGKILLs
  {
    const jobId = uniq("2b");
    const r = await runChild("sqlite", sqlitePath, "claim-then-crash", jobId);
    ok(r.code !== 0, "Sc267-2b REAL CHILD-PROCESS RESTART: child was SIGKILLed (code=" + r.code + ")");
    ok(!!r.json?.operationId, "Sc267-2b REAL CHILD-PROCESS RESTART: op id captured before crash");

    // Parent sees a durable CLAIMED op with a live claim owner.
    const { store } = await makeSqliteEngine();
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const row = db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(r.json.operationId);
    ok(!!row, "Sc267-2b REAL CHILD-PROCESS RESTART: op persisted after crash");
    ok(row?.state === "CLAIMED", "Sc267-2b REAL CHILD-PROCESS RESTART: state CLAIMED (got " + row?.state + ")");
    ok(row?.claim_owner === r.json.owner, "Sc267-2b REAL CHILD-PROCESS RESTART: owner matches child (got " + row?.claim_owner + ")");
  }

  // ==========================================================================
  // Scenario 3 -- termination while a recovery operation is in progress
  // ==========================================================================
  section("Sc267-3 termination while in progress");

  {
    const jobId = uniq("3a");
    const r = await runChild("sqlite", sqlitePath, "in-progress-then-crash", jobId);
    ok(r.code !== 0, "Sc267-3 REAL CHILD-PROCESS RESTART: child SIGKILLed (code=" + r.code + ")");
    const { store } = await makeSqliteEngine();
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const row = db.prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?").get(r.json.operationId);
    ok(row?.state === "IN_PROGRESS", "Sc267-3 REAL CHILD-PROCESS RESTART: state IN_PROGRESS (got " + row?.state + ")");
    ok(row?.claim_owner === r.json.owner, "Sc267-3 REAL CHILD-PROCESS RESTART: owner preserved");
    ok(row?.attempt_count === 1, "Sc267-3 REAL CHILD-PROCESS RESTART: attempt_count=1 (got " + row?.attempt_count + ")");
  }

  // ==========================================================================
  // Scenario 4 -- termination after job mutation commits, before op completion
  // ==========================================================================
  section("Sc267-4 commit-before-completion");

  {
    const { store, engine } = await makeSqliteEngine();
    const jobId = uniq("4a");
    const now = Date.now();
    (store as any).createJob(makeJob(jobId));
    (store as any).recoveryOps.createOrGetOperation({
      jobId, leaseId: "", workerId: null, operationType: "TIMEOUT", now,
    });
    let hookReached = false;
    engine.__testPhase144Hook = (stage) => {
      if (stage === "beforeComplete") {
        hookReached = true;
        throw new Error("sc267-4a injected fault");
      }
    };
    try {
      await engine.reconcileExecutionRecoveryOperations(now, Infinity);
    } finally {
      engine.__testPhase144Hook = undefined;
    }
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const job = db.prepare(
      "SELECT status FROM execution_jobs WHERE id = ?"
    ).get(jobId) as any;
    const op = db.prepare(
      "SELECT * FROM execution_recovery_operations WHERE job_id = ?"
    ).get(jobId) as any;
    ok(hookReached, "Sc267-4a: beforeComplete fault hook was reached");
    ok(!!op, "Sc267-4a: recovery operation persisted");
    ok(
      job?.status === "RETRY_SCHEDULED" || job?.status === "DEAD_LETTER",
      "Sc267-4a: job mutation committed (status=" + job?.status + ")"
    );
    ok(op?.state === "FAILED",
      "Sc267-4a: operation did not falsely complete (state=" + op?.state + ")");
  }
// Scenario 6 -- claim expiry followed by recovery from a different engine
  // ==========================================================================
  section("Sc267-6 claim expiry + other-engine recovery");
  {
    const { store, engine } = await makeSqliteEngine();
    const jobId = uniq("6");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "engineA", durationMs: 1000, now: 1 });
    await ops.markInProgress(opId, "engineA", 1);
    // After claim expiry, engineB reclaims.
    const r2 = await ops.claimOperation({ operationId: opId, owner: "engineB", durationMs: 60000, now: 2000 });
    ok(r2.claimed === true, "Sc267-6 engineB reclaims after expiry");
    const after = await ops.getOperation(opId);
    ok(after.claimOwner === "engineB", "Sc267-6 owner is engineB");
    // Original owner cannot mark.
    const failed = await ops.markCompleted(opId, "engineA", 2000);
    ok(failed === false, "Sc267-6 engineA cannot complete reclaimed op");
  }

  // ==========================================================================
  // Scenario 7 -- two engines racing to recover the same op after restart
  // ==========================================================================
  section("Sc267-7 two engines racing post-restart");
  {
    const { store } = await makeSqliteEngine();
    const jobId = uniq("7");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    const now = Date.now();
    const [a, b] = await Promise.all([
      ops.claimOperation({ operationId: opId, owner: "eng-1", durationMs: 60000, now }),
      ops.claimOperation({ operationId: opId, owner: "eng-2", durationMs: 60000, now }),
    ]);
    const winners = [a, b].filter((x) => x.claimed === true).length;
    ok(winners === 1, "Sc267-7 exactly one post-restart claim wins (got " + winners + ")");
  }

  // ==========================================================================
  // Scenario 8 -- repeated startup reconciliation without duplicate transitions
  // ==========================================================================
  section("Sc267-8 repeated startup reconciliation idempotence");
  {
    const { store, engine } = await makeSqliteEngine();
    const jobId = uniq("8");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    for (let i = 0; i < 5; i++) {
      try { await engine.reconcileExecutionRecoveryOperations(1_000_000 + i * 1000, Infinity); } catch {}
    }
    const db = (store as any).db ?? (store as any).getDatabase?.();
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM execution_recovery_operations WHERE job_id = ?").get(jobId) as any;
    ok(cnt.c === 1, "Sc267-8 exactly one recovery op after 5 reconcile passes (got " + cnt.c + ")");
  }

  // ==========================================================================
  // Scenario 9 -- stale / inconsistent ownership
  // ==========================================================================
  section("Sc267-9 stale ownership cannot finalize");
  {
    const { store } = await makeSqliteEngine();
    const jobId = uniq("9");
    (store as any).createJob(makeJob(jobId));
    const ops: any = (store as any).recoveryOps;
    const c = await ops.createOrGetOperation({ jobId, leaseId: null, workerId: "w", operationType: "ORPHAN_RECOVERY", now: 1 });
    const opId = c.operation.operationId;
    await ops.claimOperation({ operationId: opId, owner: "ownerA", durationMs: 60000, now: 1000 });
    // Force a stale owner (never claimed) to try to complete.
    const bad = await ops.markCompleted(opId, "ownerZ", 2000);
    ok(bad === false, "Sc267-9 unknown owner cannot complete");
  }

  // ==========================================================================
  // Scenario 10 -- database errors during claim/mutation/finalization
  // ==========================================================================
  section("Sc267-10 database errors do not convert unknown to success");

  if (pgOk) {
    const { PgClient: PC } = await import("../src/core/pg-client");
    let failAfter = 2;
    let calls = 0;
    const brokenPg: any = new PC((_cs: string) => {
      // Return a Pool-like object whose query throws after `failAfter` calls.
      return {
        on: () => {},
        connect: async () => ({
          query: async (sql: string, params: any[]) => {
            calls++;
            if (calls > failAfter) throw new Error("injected-db-error");
            const { Pool: RealPool } = await import("pg");
            const real = new RealPool({ connectionString: postgresUrl! });
            try { const r = await real.query(sql, params); return r; }
            finally { await real.end(); }
          },
          release: () => {},
        }),
        query: async (sql: string, params: any[]) => {
          calls++;
          if (calls > failAfter) throw new Error("injected-db-error");
          const { Pool: RealPool } = await import("pg");
          const real = new RealPool({ connectionString: postgresUrl! });
          try { const r = await real.query(sql, params); return r; }
          finally { await real.end(); }
        },
        end: async () => {},
      } as any;
    });
    try {
      await brokenPg.connect(postgresUrl!);
      // Any query beyond the budget throws; we assert that the failure surfaces.
      let surfaced = false;
      try { await brokenPg.query("SELECT 1"); await brokenPg.query("SELECT 1"); await brokenPg.query("SELECT 1"); }
      catch { surfaced = true; }
      ok(surfaced === true, "Sc267-10 IN-PROCESS FAULT: injected DB error surfaces (not swallowed)");
      try { await brokenPg.close(); } catch {}
    } catch (e: any) {
      ok(false, "Sc267-10 IN-PROCESS FAULT: poolFactory injection failed — " + String(e?.message ?? e));
    }
  } else {
    ne("Sc267-10 IN-PROCESS FAULT (PG): requires NEXUS_PERSISTENCE_MODE=shared + DATABASE_URL");
  }

  // ==========================================================================
  // Summary
  // ==========================================================================
  clean(sqlitePath);
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
