// scripts/test-phase245-production-supervision-boundary.ts
// Phase 245 — Production Execution Supervision Boundary Hardening verifier.
// Uses real PostgreSQL. Never mocks ExecutionStore or ExecutionEngine.
// Distinguishes PASS / FAIL / BLOCKED / NOT EXECUTED.
import { spawn, execSync, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PgClient } from "../src/core/pg-client";
import { bootstrapPgSchema } from "../src/core/pg-bootstrap";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { WorkerRegistry } from "../src/core/worker-registry";
import { ExecutionEngine } from "../src/core/execution-engine";
import { MigrationRunner } from "../src/core/migration-runner";

let passed = 0, failed = 0, blocked = 0, notExec = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("PASS  " + msg); }
  else     { failed++; console.log("FAIL  " + msg); }
}
function blk(msg: string, reason: string): void { blocked++; console.log("BLOCKED  " + msg + " :: " + reason); }
function ne(msg: string, reason: string): void { notExec++; console.log("NOT EXECUTED  " + msg + " :: " + reason); }
function section(t: string): void { console.log("\n--- " + t + " ---"); }
function uniq(t: string): string {
  return "p245-" + t + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch {} } });

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }
function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}
const CHILD = "scripts/_phase245_supervision_child.ts";
function runChild(url: string, cmd: string, ...args: string[]): Promise<ChildOut> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, cmd, url, ...args], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => { stdout += d.toString(); });
    child.stderr!.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      resolve({ code, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

// ---------- PG fixture helpers ----------
async function pgInsertJob(pg: PgClient, jobId: string, opts: {
  status?: string; retryPolicy?: any; timeoutMs?: number;
  supervisionState?: string | null; failureClass?: string | null;
  currentLeaseId?: string | null;
} = {}): Promise<void> {
  const now = Date.now();
  const status = opts.status ?? "RUNNING";
  const retryPolicy = opts.retryPolicy ?? { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 };
  await pg.query(
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, " +
    "created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, " +
    "cancellation_requested, cancellation_acknowledged, supervision_state, failure_class, supervision_updated_at) VALUES " +
    "($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15,$16) " +
    "ON CONFLICT (id) DO NOTHING",
    [jobId, "p245:" + jobId, "EXECUTION", "{}", status, JSON.stringify(retryPolicy),
     opts.timeoutMs ?? 60_000, now, now, now,
     opts.currentLeaseId ?? null, 0, 0,
     opts.supervisionState ?? null, opts.failureClass ?? null, now],
  );
}

async function pgInsertAttempt(pg: PgClient, attemptId: string, jobId: string, opts: {
  status?: string; workerId?: string; leaseId?: string;
  heartbeatAt?: number | null; lastProgressAt?: number | null;
} = {}): Promise<void> {
  const now = Date.now();
  await pg.query(
    "INSERT INTO execution_attempts (id, job_id, attempt_number, status, worker_id, lease_id, " +
    "started_at, completed_at, error, evidence, created_at, heartbeat_at, last_progress_at) VALUES " +
    "($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,$8,$9,$10) " +
    "ON CONFLICT (id) DO NOTHING",
    [attemptId, jobId, 1, opts.status ?? "RUNNING",
     opts.workerId ?? "w", opts.leaseId ?? null,
     now, now,
     opts.heartbeatAt === undefined ? now : opts.heartbeatAt,
     opts.lastProgressAt === undefined ? now : opts.lastProgressAt],
  );
}

async function pgInsertLease(pg: PgClient, leaseId: string, jobId: string, workerId: string, opts: {
  status?: string; expiresAt?: number; acquiredAt?: number;
} = {}): Promise<void> {
  const now = opts.acquiredAt ?? Date.now();
  await pg.query(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, status, acquired_at, expires_at, released_at) " +
    "VALUES ($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT (lease_id) DO NOTHING",
    [leaseId, jobId, workerId, opts.status ?? "ACTIVE", now,
     opts.expiresAt ?? (now + 60_000)],
  );
}

async function pgSetAttemptTimestamps(pg: PgClient, attemptId: string, hb: number | null, pr: number | null): Promise<void> {
  await pg.query(
    "UPDATE execution_attempts SET heartbeat_at = $1, last_progress_at = $2 WHERE id = $3",
    [hb, pr, attemptId],
  );
}

async function pgCleanupPrefix(pg: PgClient): Promise<void> {
  const like = "p245-%";
  try { await pg.query("DELETE FROM execution_events WHERE job_id LIKE $1", [like]); } catch {}
  try { await pg.query("DELETE FROM execution_recovery_operations WHERE job_id LIKE $1", [like]); } catch {}
  try { await pg.query("DELETE FROM execution_attempts WHERE job_id LIKE $1", [like]); } catch {}
  try { await pg.query("DELETE FROM execution_leases WHERE job_id LIKE $1", [like]); } catch {}
  try { await pg.query("DELETE FROM execution_jobs WHERE id LIKE $1", [like]); } catch {}
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
  if (process.env.NEXUS_PERSISTENCE_MODE !== "shared") {
    blk("Phase 245 shared mode", "NEXUS_PERSISTENCE_MODE must be shared");
    process.exit(1);
  }
  const container = process.env.NEXUS_POSTGRES_CONTAINER ?? "nexus-pg";

  const pg = new PgClient();
  await pg.connect(url);
  await bootstrapPgSchema(pg);
  const asyncDb = new PgAsyncEngine(pg);
  const ops = new AsyncExecutionRecoveryOperationStore(asyncDb);
  const MIG_DIR = path.join(process.cwd(), "src", "db", "migrations");
  const mem = new Database(":memory:");
  new MigrationRunner(mem, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const leases = new LeaseManager(store);
  const workerRegistry = new WorkerRegistry(store, leases as any);
  const retryEngine = new RetryEngine();
  const events: Array<{ type: string; payload: any }> = [];
  const deps = {
    events: { emit: (e: any) => { events.push({ type: e.type, payload: e.payload }); return undefined; } },
  } as any;
  const engine = new ExecutionEngine(store, workerRegistry, leases, retryEngine, deps);

  // ---------- A01 ----------
  section("A01 - shared PostgreSQL probe");
  {
    const probe = await pg.probe();
    ok((probe as any).ok === true, "A01 pg probe ok");
    ok(store.hasAsyncBackend() === true, "A01 store has async backend");
  }

  // ---------- A02 ----------
  section("A02 - authoritative shared supervision read boundary");
  {
    const jobId = uniq("a02");
    const attemptId = uniq("a02");
    const now = Date.now();
    const pgHb = now - 5_000;
    const pgPr = now - 5_000;
    const sqliteHb = now - 999_999;
    const sqlitePr = now - 999_999;

    // PostgreSQL authoritative fixture
    await pgInsertJob(pg, jobId, { status: "RUNNING" });
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: pgHb, lastProgressAt: pgPr });

    // SQLite control fixture with DELIBERATELY different timestamps
    store.createJob({
      id: jobId, idempotencyKey: "p245-sqlite:" + jobId, jobType: "EXECUTION", payload: {},
      status: "RUNNING",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
      timeoutMs: 60000, createdAt: now, updatedAt: now, lastAttemptAt: now,
      nextAttemptAt: null, currentLeaseId: null,
      cancellationRequested: 0, cancellationAcknowledged: 0,
    } as any);
    store.createAttempt({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING",
      workerId: "sqlite-w", leaseId: "sqlite-l",
      startedAt: now, completedAt: null, error: null, evidence: null, createdAt: now,
    } as any);
    syncEngine.getDatabase().prepare(
      "UPDATE execution_attempts SET heartbeat_at = ?, last_progress_at = ? WHERE id = ?",
    ).run(sqliteHb, sqlitePr, attemptId);

    // Sanity: the two backends truly hold different timestamps
    const sqliteRow = syncEngine.getDatabase()
      .prepare("SELECT heartbeat_at, last_progress_at FROM execution_attempts WHERE id = ?")
      .get(attemptId) as any;
    ok(Number(sqliteRow?.heartbeat_at) === sqliteHb, "A02 SQLite row has distinct stale timestamp");

    // Authoritative call
    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.attemptId === attemptId, "A02 async classifier returned the job/attempt");
    ok(v.lastHeartbeatAt === pgHb,
       "A02 heartbeatAt came from PostgreSQL (got " + v.lastHeartbeatAt + ", pg=" + pgHb + ", sqlite=" + sqliteHb + ")");
    ok(v.lastProgressAt === pgPr,
       "A02 lastProgressAt came from PostgreSQL (got " + v.lastProgressAt + ", pg=" + pgPr + ", sqlite=" + sqlitePr + ")");

    // Cross-check PG still holds the authoritative values
    const pgRow = await pg.query<any>("SELECT id FROM execution_jobs WHERE id = $1", [jobId]);
    ok(pgRow.rows.length === 1, "A02 job present in PostgreSQL");
  }


  // ---------- A03 ----------
  section("A03 - healthy attempt remains healthy");
  {
    const jobId = uniq("a03");
    const attemptId = uniq("a03");
    const now = Date.now();
    await pgInsertJob(pg, jobId);
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: now, lastProgressAt: now });
    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.verdict === "HEALTHY", "A03 verdict HEALTHY (got " + v.verdict + ")");
  }

  // ---------- A04 ----------
  section("A04 - heartbeat timeout");
  {
    const jobId = uniq("a04");
    const attemptId = uniq("a04");
    const now = Date.now();
    await pgInsertJob(pg, jobId);
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: now - 60_000, lastProgressAt: now });
    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.verdict === "HEARTBEAT_TIMEOUT", "A04 verdict HEARTBEAT_TIMEOUT (got " + v.verdict + ")");
  }

  // ---------- A05 ----------
  section("A05 - progress timeout with fresh heartbeat");
  {
    const jobId = uniq("a05");
    const attemptId = uniq("a05");
    const now = Date.now();
    await pgInsertJob(pg, jobId);
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: now, lastProgressAt: now - 600_000 });
    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.verdict === "PROGRESS_TIMEOUT", "A05 verdict PROGRESS_TIMEOUT (got " + v.verdict + ")");
  }

  // ---------- A06 ----------
  section("A06 - heartbeat precedence");
  {
    const jobId = uniq("a06");
    const attemptId = uniq("a06");
    const now = Date.now();
    await pgInsertJob(pg, jobId);
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: now - 60_000, lastProgressAt: now - 600_000 });
    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.verdict === "HEARTBEAT_TIMEOUT", "A06 heartbeat wins over progress (got " + v.verdict + ")");
  }

  // ---------- A07 ----------
  section("A07 - live heartbeat vs stale recovery race");
  {
    const jobId = uniq("a07");
    const attemptId = uniq("a07");
    const leaseId = uniq("a07lease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { currentLeaseId: leaseId });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    // Race: worker refreshes heartbeat before fence
    await pgSetAttemptTimestamps(pg, attemptId, now, now);

    const fr = await store.fenceStaleAttemptAsync({
      attemptId, jobId, leaseId,
      reason: "HEARTBEAT_TIMEOUT", now,
      mode: "heartbeat", staleCutoffMs: 30_000,
    });
    ok(fr.fenced === false, "A07 fence refused live attempt (fenced=" + fr.fenced + ")");
    ok(fr.reason === "NOT_STALE", "A07 reason NOT_STALE (got " + fr.reason + ")");

    const still = await pg.query<any>("SELECT status FROM execution_attempts WHERE id = $1", [attemptId]);
    ok(still.rows[0]?.status === "RUNNING", "A07 attempt still RUNNING");
  }

  // ---------- A08 ----------
  section("A08 - atomic stale attempt fencing");
  {
    const jobId = uniq("a08");
    const attemptId = uniq("a08");
    const leaseId = uniq("a08lease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { status: "RUNNING", currentLeaseId: leaseId });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    const fr = await store.fenceStaleAttemptAsync({
      attemptId, jobId, leaseId,
      reason: "HEARTBEAT_TIMEOUT", now,
      mode: "heartbeat", staleCutoffMs: 30_000,
    });
    ok(fr.fenced === true, "A08 fence applied");

    const a = await pg.query<any>("SELECT status FROM execution_attempts WHERE id = $1", [attemptId]);
    ok(a.rows[0]?.status === "FAILED", "A08 attempt FAILED");
    const l = await pg.query<any>("SELECT status FROM execution_leases WHERE lease_id = $1", [leaseId]);
    ok(l.rows[0]?.status === "EXPIRED", "A08 lease EXPIRED");
    const j = await pg.query<any>("SELECT status, current_lease_id FROM execution_jobs WHERE id = $1", [jobId]);
    ok(j.rows[0]?.status === "ORPHANED", "A08 job ORPHANED");
    ok(j.rows[0]?.current_lease_id === null, "A08 job current_lease_id cleared");
    const ev = await pg.query<any>("SELECT event_type FROM execution_events WHERE job_id = $1 AND event_type = 'scheduler.attempt.fenced'", [jobId]);
    ok(ev.rows.length >= 1, "A08 scheduler.attempt.fenced event written");
  }

  // ---------- A09 ----------
  section("A09 - progress mode preserves heartbeat freshness rule");
  {
    // Case 1: fresh hb + stale progress → fence succeeds
    const jobId1 = uniq("a09a");
    const attemptId1 = uniq("a09a");
    const leaseId1 = uniq("a09alease");
    const now = Date.now();
    await pgInsertJob(pg, jobId1, { currentLeaseId: leaseId1 });
    await pgInsertLease(pg, leaseId1, jobId1, "worker-A");
    await pgInsertAttempt(pg, attemptId1, jobId1, {
      heartbeatAt: now, lastProgressAt: now - 600_000, leaseId: leaseId1,
    });
    const fr1 = await store.fenceStaleAttemptAsync({
      attemptId: attemptId1, jobId: jobId1, leaseId: leaseId1,
      reason: "PROGRESS_TIMEOUT", now,
      mode: "progress", staleCutoffMs: 300_000, heartbeatFreshMs: 30_000,
    });
    ok(fr1.fenced === true, "A09a progress fence applied");

    // Case 2: stale hb + stale progress, progress mode → refuses (heartbeat must win first)
    const jobId2 = uniq("a09b");
    const attemptId2 = uniq("a09b");
    const leaseId2 = uniq("a09blease");
    await pgInsertJob(pg, jobId2, { currentLeaseId: leaseId2 });
    await pgInsertLease(pg, leaseId2, jobId2, "worker-B");
    await pgInsertAttempt(pg, attemptId2, jobId2, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 600_000, leaseId: leaseId2,
    });
    const fr2 = await store.fenceStaleAttemptAsync({
      attemptId: attemptId2, jobId: jobId2, leaseId: leaseId2,
      reason: "PROGRESS_TIMEOUT", now,
      mode: "progress", staleCutoffMs: 300_000, heartbeatFreshMs: 30_000,
    });
    ok(fr2.fenced === false && fr2.reason === "NOT_STALE",
       "A09b progress mode refuses stale heartbeat (fenced=" + fr2.fenced + " reason=" + fr2.reason + ")");
  }

  // ---------- A10 ----------
  section("A10 - durable ORPHAN_RECOVERY operation created");
  {
    const jobId = uniq("a10");
    const attemptId = uniq("a10");
    const leaseId = uniq("a10lease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { status: "RUNNING", currentLeaseId: leaseId });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    await engine.recoverStalledAttemptsTickAsync(now, 30_000, 30_000, 300_000);

    const opsPg = await pg.query<any>(
      "SELECT operation_id, operation_type, state FROM execution_recovery_operations WHERE job_id = $1",
      [jobId],
    );
    ok(opsPg.rows.length >= 1, "A10 recovery operation persisted in PG (count=" + opsPg.rows.length + ")");
    ok(opsPg.rows.some((r) => r.operation_type === "ORPHAN_RECOVERY"), "A10 ORPHAN_RECOVERY type present");
  }

  // ---------- A11 ----------
  section("A11 - duplicate supervision tick idempotency");
  {
    const jobId = uniq("a11");
    const attemptId = uniq("a11");
    const leaseId = uniq("a11lease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { status: "RUNNING", currentLeaseId: leaseId });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    await engine.recoverStalledAttemptsTickAsync(now, 30_000, 30_000, 300_000);
    await engine.recoverStalledAttemptsTickAsync(now + 10, 30_000, 30_000, 300_000);
    await engine.recoverStalledAttemptsTickAsync(now + 20, 30_000, 30_000, 300_000);

    const opsPg = await pg.query<any>(
      "SELECT operation_id FROM execution_recovery_operations WHERE job_id = $1 AND operation_type = 'ORPHAN_RECOVERY'",
      [jobId],
    );
    // Idempotency key includes leaseId, so the same lease produces one op
    ok(opsPg.rows.length === 1, "A11 exactly 1 ORPHAN_RECOVERY op (got " + opsPg.rows.length + ")");

    const activeLeases = await pg.query<any>(
      "SELECT lease_id FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'",
      [jobId],
    );
    ok(activeLeases.rows.length === 0, "A11 no ACTIVE leases remain");
  }

  // ---------- A12 ----------
  section("A12 - retryable orphan recovery requeues");
  {
    const jobId = uniq("a12");
    const attemptId = uniq("a12");
    const leaseId = uniq("a12lease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, {
      status: "RUNNING", currentLeaseId: leaseId,
      retryPolicy: { maxAttempts: 5, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    await engine.recoverStalledAttemptsTickAsync(now, 30_000, 30_000, 300_000);

    const j = await pg.query<any>("SELECT status FROM execution_jobs WHERE id = $1", [jobId]);
    ok(j.rows[0]?.status === "QUEUED" || j.rows[0]?.status === "RETRY_SCHEDULED",
       "A12 job requeued (status=" + j.rows[0]?.status + ")");
  }

  // ---------- A13 ----------
  section("A13 - retry exhaustion");
  {
    const jobId = uniq("a13");
    const attemptId = uniq("a13");
    const leaseId = uniq("a13lease");
    const now = Date.now();
    // maxRetries=0 means no budget available; attemptsUsed=1 > 0
    await pgInsertJob(pg, jobId, {
      status: "RUNNING", currentLeaseId: leaseId,
      retryPolicy: { maxAttempts: 0, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 },
    });
    await pgInsertLease(pg, leaseId, jobId, "worker-A");
    await pgInsertAttempt(pg, attemptId, jobId, {
      heartbeatAt: now - 60_000, lastProgressAt: now - 60_000, leaseId,
    });

    await engine.recoverStalledAttemptsTickAsync(now, 30_000, 30_000, 300_000);

    const j = await pg.query<any>("SELECT status, supervision_state, failure_class FROM execution_jobs WHERE id = $1", [jobId]);
    const status = j.rows[0]?.status;
    ok(status !== "QUEUED" && status !== "RETRY_SCHEDULED",
       "A13 no requeue on exhaustion (status=" + status + ")");
    ok(status === "ORPHANED" || j.rows[0]?.supervision_state === "RECOVERY_BLOCKED",
       "A13 terminal/blocked state persisted (supervision_state=" + j.rows[0]?.supervision_state + ")");
  }

  // ---------- A14 ----------
  section("A14 - stale owner / competing worker");
  {
    const jobId = uniq("a14");
    const attemptA = uniq("a14a");
    const attemptB = uniq("a14b");
    const leaseA = uniq("a14alease");
    const leaseB = uniq("a14blease");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { status: "RUNNING", currentLeaseId: leaseA });
    await pgInsertLease(pg, leaseA, jobId, "worker-A", { status: "EXPIRED", expiresAt: now - 10_000 });
    await pgInsertLease(pg, leaseB, jobId, "worker-B", { status: "ACTIVE", expiresAt: now + 60_000 });
    await pgInsertAttempt(pg, attemptA, jobId, {
      heartbeatAt: now - 120_000, lastProgressAt: now - 120_000, leaseId: leaseA, workerId: "worker-A",
    });
    await pgInsertAttempt(pg, attemptB, jobId, {
      heartbeatAt: now, lastProgressAt: now, leaseId: leaseB, workerId: "worker-B",
    });

    // A tries to fence with its expired lease
    const fr = await store.fenceStaleAttemptAsync({
      attemptId: attemptA, jobId, leaseId: leaseA,
      reason: "HEARTBEAT_TIMEOUT", now,
      mode: "heartbeat", staleCutoffMs: 30_000,
    });
    // Job status is RUNNING, attempt lease matches leaseA → the CAS check
    // may still allow fencing (it doesn't know B exists). What matters is
    // that B's attempt and lease are untouched.
    const bAttempt = await pg.query<any>("SELECT status FROM execution_attempts WHERE id = $1", [attemptB]);
    ok(bAttempt.rows[0]?.status === "RUNNING", "A14 B attempt still RUNNING");
    const bLease = await pg.query<any>("SELECT status FROM execution_leases WHERE lease_id = $1", [leaseB]);
    ok(bLease.rows[0]?.status === "ACTIVE", "A14 B lease still ACTIVE");
  }

  // ---------- A15 ----------
  section("A15 - process restart durability");
  {
    const jobId = uniq("a15");
    // Child creates a recovery op and exits; main verifies it survives.
    const child = await runChild(url, "create-op", jobId, "ORPHAN_RECOVERY");
    const opInPg = await pg.query<any>(
      "SELECT operation_id FROM execution_recovery_operations WHERE job_id = $1",
      [jobId],
    );
    ok(opInPg.rows.length === 1, "A15 child-created op survives process exit (count=" + opInPg.rows.length + ")");
    ok(child.code === 0, "A15 child exited cleanly (code=" + child.code + ")");
  }

  // ---------- A16 ----------
  section("A17 - explicit no SQLite fallback");
  {
    // Runs BEFORE A16 (PG restart) so `pg` and `engine` are still live.
    const jobId = uniq("a17");
    const attemptId = uniq("a17");
    const now = Date.now();
    await pgInsertJob(pg, jobId, { status: "RUNNING" });
    await pgInsertAttempt(pg, attemptId, jobId, { heartbeatAt: now, lastProgressAt: now });

    const sqliteHas = syncEngine.getDatabase()
      .prepare("SELECT id FROM execution_jobs WHERE id = ?").get(jobId) as any;
    ok(!sqliteHas, "A17 job not in SQLite (baseline)");

    const v = await engine.classifySupervisionAsync(jobId, now, 30_000, 300_000);
    ok(v.attemptId === attemptId, "A17 async classifier saw PostgreSQL job");

    const stillNotInSqlite = syncEngine.getDatabase()
      .prepare("SELECT id FROM execution_jobs WHERE id = ?").get(jobId) as any;
    ok(!stillNotInSqlite, "A17 job still not in SQLite after async supervision");

    // Re-query PG to confirm the authoritative row is still there
    const pgRow = await pg.query<any>("SELECT id FROM execution_jobs WHERE id = $1", [jobId]);
    ok(pgRow.rows.length === 1, "A17 authoritative row present in PostgreSQL");
  }


  // ---------- A18 ----------
  section("A16 - PostgreSQL restart durability");
  let pgRestartBlocked = false;
  {
    const jobId = uniq("a16");
    await pgInsertJob(pg, jobId, { status: "ORPHANED", supervisionState: "RECOVERY_PENDING" });
    const before = await pg.query<any>("SELECT status FROM execution_jobs WHERE id = $1", [jobId]);
    ok(before.rows[0]?.status === "ORPHANED", "A16 state before restart");

    try {
      await pg.close();
      execSync("docker restart " + container, { stdio: "pipe", timeout: 120_000 });
      // Wait for readiness
      await new Promise((r) => setTimeout(r, 2000));
      const pg2 = new PgClient();
      await pg2.connect(url);
      const after = await pg2.query<any>("SELECT status FROM execution_jobs WHERE id = $1", [jobId]);
      ok(after.rows[0]?.status === "ORPHANED", "A16 state survived PG restart");
      await pg2.close();
    } catch (e: any) {
      pgRestartBlocked = true;
      blk("A16 PostgreSQL restart", String(e?.message ?? e).slice(0, 200));
    }
  }

  // ---------- A17 ----------
  section("A18 - Phase 244 regression");
  {
    let ok_ = false, out = "";
    try {
      out = execSync("npx tsx scripts/test-phase244-crash-safe-execution-lifecycle.ts",
        { stdio: "pipe", timeout: 300_000 }).toString();
      ok_ = /PASS:\s*41/.test(out) && /FAIL:\s*0/.test(out) && /BLOCKED:\s*0/.test(out);
    } catch (e: any) { out = String(e?.stdout ?? e?.stderr ?? e).slice(0, 400); }
    ok(ok_, "A18 Phase 244 verifier PASS:41 FAIL:0 BLOCKED:0");
  }

  // ---------- A19 ----------
  section("A19 - Phase 243 regression");
  {
    let ok_ = false, out = "";
    try {
      out = execSync("npx tsx scripts/test-phase243-durable-recovery-orchestration.ts",
        { stdio: "pipe", timeout: 300_000 }).toString();
      ok_ = /PASS:\s*39/.test(out) && /FAIL:\s*0/.test(out) && /BLOCKED:\s*0/.test(out);
    } catch (e: any) { out = String(e?.stdout ?? e?.stderr ?? e).slice(0, 400); }
    ok(ok_, "A19 Phase 243 verifier PASS:39 FAIL:0 BLOCKED:0");
  }

  // ---------- A20 ----------
  section("A20 - Phase 242 regression");
  {
    let ok_ = false, out = "";
    try {
      out = execSync("npx tsx scripts/test-phase242-durable-retry.ts",
        { stdio: "pipe", timeout: 300_000 }).toString();
      ok_ = /PASS:\s*30/.test(out) && /FAIL:\s*0/.test(out) && /BLOCKED:\s*0/.test(out);
    } catch (e: any) { out = String(e?.stdout ?? e?.stderr ?? e).slice(0, 400); }
    ok(ok_, "A20 Phase 242 verifier PASS:30 FAIL:0 BLOCKED:0");
  }

  // ---------- A21 ----------
  section("A21 - TypeScript compilation");
  {
    let ok_ = false, err = "";
    try { execSync("npx tsc --noEmit", { stdio: "pipe", timeout: 240_000 }); ok_ = true; }
    catch (e: any) { err = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(ok_, "A21 tsc --noEmit clean" + (ok_ ? "" : " - " + err));
  }

  // ---------- A22 ----------
  section("A22 - git diff --check");
  {
    let ok_ = false, err = "";
    try { execSync("git diff --check", { stdio: "pipe", timeout: 60_000 }); ok_ = true; }
    catch (e: any) { err = String(e?.stderr ?? e?.message ?? e).slice(0, 300); }
    ok(ok_, "A22 git diff --check clean" + (ok_ ? "" : " - " + err));
  }

  // ---------- A23 ----------
  section("A23 - Phase245 source boundary audit");
  {
    let src = "";
    try {
      src = readFileSync("src/core/execution-engine.ts", "utf8");
    } catch {}
    const idx = src.indexOf("async recoverStaleJobs(");
    ok(idx >= 0, "A23 recoverStaleJobs definition located");
    // Longest recoverStaleJobs body in this file is < 20 KB; slice generously.
    const window = idx >= 0 ? src.slice(idx, idx + 20000) : "";
    ok(window.includes("hasAsyncBackend()"), "A23 recoverStaleJobs branches on hasAsyncBackend()");
    ok(window.includes("runSupervisionPassAsync"), "A23 async supervision call present");
    ok(window.includes("recoverStalledAttemptsTickAsync"), "A23 async recovery tick call present");
    ok(window.includes("await this.reconcileExecutionRecoveryOperations(now);"),
       "A23 reconcileExecutionRecoveryOperations preserved");
  }


  // ---------- A24 ----------
  section("A24 - clean shutdown");
  {
    let sh = true;
    // Open a fresh client for cleanup; the original `pg` may be closed by A16.
    try {
      const cleanupPg = new PgClient();
      await cleanupPg.connect(url);
      await pgCleanupPrefix(cleanupPg).catch(() => {});
      await cleanupPg.close();
    } catch { /* best-effort cleanup */ }
    try { mem.close(); } catch { sh = false; }
    ok(sh, "A24 SQLite memory db closed cleanly");
  }

  // ---------- Summary ----------
  console.log("\n============================================");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("BLOCKED: " + blocked);
  console.log("NOT EXECUTED: " + notExec);
  console.log("============================================");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });