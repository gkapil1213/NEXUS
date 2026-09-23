// scripts/test-phase183d-runtime-consumers.ts
// Phase 183d - runtime consumer migration verifier.
//
// Proves: async attempt surface is Postgres-backed; ExecutionEngine's io
// facade selects the async path when hasAsyncBackend() is true;
// completeAttemptAndTransitionJobAsync is atomic and fenced; SQLite mode
// is unchanged; no silent fallback.
//
// Scope note: WorkerRegistry remains synchronous in this slice. Its
// callers (claimNextJob, recoverStaleJobs, job-dispatcher) require an
// async cascade deferred to 183e.

import { spawn, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { join } from "path";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionEngine } from "../src/core/execution-engine";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183d_child.ts";
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGKILL"); } catch {} } });

interface ChildOut { code: number | null; stdout: string; stderr: string; json: any | null; }
function parseJson(s: string): any | null {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}
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

function mkJob(id: string, status = "RUNNING"): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "ck-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status,
    createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  };
}

async function seedActiveLease(pg: PgClient, leaseId: string, jobId: string, workerId: string, ttlMs = 60_000): Promise<void> {
  const now = Date.now();
  await pg.query(
    "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
    [leaseId, jobId, workerId, now, now + ttlMs],
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);
  const mem = new Database(":memory:");
  const syncEngine = SQLiteEngine.fromDatabase(mem);
  const store = new ExecutionStore(syncEngine, asyncDb);

  section("A01-A04 - shared mode configuration + runtime wiring");
  {
    const probe = await pg.probe();
    ok(probe.ok === true, "A01 Postgres probe ok");
    ok(store.hasAsyncBackend() === true, "A02 store.hasAsyncBackend() true in shared mode");

    const workerRegistry = new WorkerRegistry(store);
    const leaseManager = new LeaseManager(store);
    const retryEngine = new RetryEngine();
    const engine = new ExecutionEngine(store, workerRegistry, leaseManager, retryEngine, {} as any);
    ok(engine.hasAsyncPersistence() === true, "A03 ExecutionEngine.hasAsyncPersistence() true in shared mode");

    const wid = "ck-worker-a04-" + Date.now();
    await store.registerWorkerAsync({
      workerId: wid, hostname: "test", status: "IDLE",
      registeredAt: Date.now(), lastHeartbeatAt: Date.now(),
    } as any);
    const row = await pg.query<{ worker_id: string }>("SELECT worker_id FROM execution_workers WHERE worker_id = $1", [wid]);
    ok(row.rows[0]?.worker_id === wid, "A04 worker registered via async lands in Postgres");
  }

  section("A05-A09 - async attempts surface");
  {
    const jobId = "ck-job-a05-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const attemptId = "ck-a05-" + Date.now();
    const now = Date.now();
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    const back = await store.getAttemptAsync(attemptId);
    ok(back?.id === attemptId, "A05 createAttemptAsync round-trip");

    const jobId6 = "ck-job-a06-" + Date.now();
    await store.createJobAsync(mkJob(jobId6));
    const leaseId6 = "ck-lease-a06-" + Date.now();
    await seedActiveLease(pg, leaseId6, jobId6, "w-A06");
    const attemptId6 = "ck-a06-" + Date.now();
    const created6 = await store.createAttemptAsOwnerAsync(
      { id: attemptId6, jobId: jobId6, attemptNumber: 1, status: "RUNNING", createdAt: now } as any,
      leaseId6, "w-A06", now);
    ok(created6.created === true, "A06 createAttemptAsOwnerAsync accepted");

    await store.updateAttemptAsync({
      id: attemptId6, jobId: jobId6, attemptNumber: 1, status: "FAILED", error: "test", createdAt: now, completedAt: now,
    } as any);
    const after = await store.getAttemptAsync(attemptId6);
    ok(after?.status === "FAILED", "A07 updateAttemptAsync persisted");

    const list = await store.listAttemptsForJobAsync(jobId6);
    ok(list.length === 1 && list[0].id === attemptId6, "A08 listAttemptsForJobAsync returns it");

    const pgRow = await pg.query<{ status: string }>("SELECT status FROM execution_attempts WHERE id = $1", [attemptId6]);
    ok(pgRow.rows[0]?.status === "FAILED", "A09 Postgres has the update");
  }

  section("A10-A15 - completeAttemptAndTransitionJobAsync");
  {
    const jobId = "ck-job-a10-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a10-" + Date.now();
    await seedActiveLease(pg, leaseId, jobId, "w-A10");
    const attemptId = "ck-a10-" + Date.now();
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);

    const r10 = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: "w-A10",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
      attemptEvidence: ["step1", "step2"],
    });
    ok(r10.ok === true && r10.applied === true, "A10 completion applied");

    const a10 = await store.getAttemptAsync(attemptId);
    ok(a10?.status === "SUCCEEDED", "A11 attempt SUCCEEDED in Postgres");

    const job10 = await store.getJobAsync(jobId);
    ok(job10?.status === "SUCCEEDED", "A12 job transitioned to SUCCEEDED");

    const ev = await pg.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM execution_events WHERE job_id = $1 AND event_type = $2", [jobId, "execution.transition.succeeded"]);
    ok(ev.rows[0]?.c === "1", "A13 transition event written");

    const prov = await pg.query<{ c: string; outcome: string }>("SELECT COUNT(*)::text AS c, MAX(outcome) AS outcome FROM execution_outcome_provenance WHERE attempt_id = $1", [attemptId]);
    ok(prov.rows[0]?.c === "1" && prov.rows[0]?.outcome === "SUCCEEDED", "A14 provenance row written");

    const jobId15 = "ck-job-a15-" + Date.now();
    await store.createJobAsync(mkJob(jobId15));
    const leaseId15 = "ck-lease-a15-" + Date.now();
    await seedActiveLease(pg, leaseId15, jobId15, "w-A15");
    const attemptId15 = "ck-a15-" + Date.now();
    await store.createAttemptAsync({ id: attemptId15, jobId: jobId15, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);
    const r15 = await store.completeAttemptAndTransitionJobAsync({
      attemptId: attemptId15, jobId: jobId15, leaseId: leaseId15, workerId: "w-WRONG",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r15.ok === false && r15.reason === "WORKER_OWNERSHIP_LOST", "A15 wrong workerId rejected");

    const a15 = await store.getAttemptAsync(attemptId15);
    ok(a15?.status === "RUNNING", "A15 attempt still RUNNING after fence rejection");
  }

  section("A16-A18 - idempotency, conflict, rollback safety");
  {
    const jobId = "ck-job-a16-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a16-" + Date.now();
    await seedActiveLease(pg, leaseId, jobId, "w-A16");
    const attemptId = "ck-a16-" + Date.now();
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);

    const first = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: "w-A16",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(first.ok === true && first.applied === true, "A16 first call applied");

    const second = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: "w-A16",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(second.ok === true && second.idempotent === true, "A16 replay idempotent");

    const conflict = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: "w-A16",
      attemptStatus: "FAILED", expectedJobStatus: "RUNNING", newJobStatus: "FAILED",
    });
    ok(conflict.ok === false && conflict.reason === "ATTEMPT_STATE_MISMATCH", "A17 terminal conflict rejected");

    const jobId18 = "ck-job-a18-" + Date.now();
    await store.createJobAsync(mkJob(jobId18));
    const leaseId18 = "ck-lease-a18-" + Date.now();
    await seedActiveLease(pg, leaseId18, jobId18, "w-A18");
    const attemptId18 = "ck-a18-" + Date.now();
    await store.createAttemptAsync({ id: attemptId18, jobId: jobId18, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);

    const rb = await store.completeAttemptAndTransitionJobAsync({
      attemptId: attemptId18, jobId: jobId18, leaseId: leaseId18, workerId: "w-A18",
      attemptStatus: "SUCCEEDED",
      expectedJobStatus: "NOT_THE_STATUS",
      newJobStatus: "SUCCEEDED",
    });
    ok(rb.ok === false && rb.reason === "STATE_MISMATCH", "A18 wrong expected status -> STATE_MISMATCH");

    const aAfter = await store.getAttemptAsync(attemptId18);
    ok(aAfter?.status === "RUNNING", "A18 rollback: attempt still RUNNING");

    const provCount = await pg.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM execution_outcome_provenance WHERE attempt_id = $1", [attemptId18]);
    ok(provCount.rows[0]?.c === "0", "A18 rollback: no provenance row");

    const evCount = await pg.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM execution_events WHERE job_id = $1", [jobId18]);
    ok(evCount.rows[0]?.c === "0", "A18 rollback: no event");
  }

  section("A19-A20 - cross-process + restart");
  {
    const jobId = "ck-job-a19-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a19-" + Date.now();
    await seedActiveLease(pg, leaseId, jobId, "w-A19");
    const attemptId = "ck-a19-" + Date.now();
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);
    await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId, workerId: "w-A19",
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });

    const childRead = await runChild(url, "get-attempt", attemptId);
    ok(childRead.code === 0 && childRead.json?.found === true && childRead.json?.status === "SUCCEEDED", "A19 child reads attempt");

    const childProv = await runChild(url, "get-provenance", attemptId);
    ok(childProv.code === 0 && childProv.json?.found === true, "A19 child reads provenance");

    const pg2 = new PgClient();
    await pg2.connect(url);
    const asyncDb2 = new PgAsyncEngine(pg2);
    const store2 = new ExecutionStore(syncEngine, asyncDb2);
    const afterRestart = await store2.getAttemptAsync(attemptId);
    ok(afterRestart?.status === "SUCCEEDED", "A20 restart preserves status");
    await pg2.close();
  }

  section("A21 - SQLite compatibility");
  {
    const mem2 = new Database(":memory:");
    const syncEngine2 = SQLiteEngine.fromDatabase(mem2);
    const { MigrationRunner } = await import("../src/core/migration-runner");
    new MigrationRunner(mem2, join(process.cwd(), "src", "db", "migrations")).run();
    mem2.exec(`CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`);
    const store3 = new ExecutionStore(syncEngine2);
    ok(store3.hasAsyncBackend() === false, "A21 hasAsyncBackend false without asyncDb");

    const workerRegistry3 = new WorkerRegistry(store3);
    const leaseManager3 = new LeaseManager(store3);
    const retryEngine3 = new RetryEngine();
    const engine3 = new ExecutionEngine(store3, workerRegistry3, leaseManager3, retryEngine3, {} as any);
    ok(engine3.hasAsyncPersistence() === false, "A21 ExecutionEngine hasAsyncPersistence false in SQLite mode");

    const jobId = "ck-job-a21-" + Date.now();
    store3.createJob(mkJob(jobId));
    const now = Date.now();
    const attemptId = "ck-a21-" + now;
    store3.createAttempt({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now } as any);
    const back = store3.getAttempt(attemptId);
    ok(back?.id === attemptId, "A21 sync attempt path unchanged");
    mem2.close();
  }

  section("A22 - no silent SQLite fallback");
  {
    const sqliteRaw = new Database(":memory:");
    sqliteRaw.exec(`CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`);
    sqliteRaw.exec(`CREATE TABLE IF NOT EXISTS execution_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, worker_id TEXT, lease_id TEXT, started_at INTEGER, completed_at INTEGER, error TEXT, evidence TEXT, created_at INTEGER NOT NULL);`);
    sqliteRaw.exec(`CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER, next_attempt_at INTEGER, current_lease_id TEXT, cancellation_requested INTEGER DEFAULT 0, cancellation_acknowledged INTEGER DEFAULT 0);`);
    const syncEngine4 = SQLiteEngine.fromDatabase(sqliteRaw);
    const store4 = new ExecutionStore(syncEngine4, asyncDb);

    const jobId = "ck-job-a22-" + Date.now();
    await store4.createJobAsync(mkJob(jobId));
    const attemptId = "ck-a22-" + Date.now();
    await store4.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: Date.now(), startedAt: Date.now() } as any);

    const pgRow = await pg.query<{ id: string }>("SELECT id FROM execution_attempts WHERE id = $1", [attemptId]);
    ok(pgRow.rows[0]?.id === attemptId, "A22 Postgres has the attempt");

    const sqliteRow = sqliteRaw.prepare("SELECT COUNT(*) AS c FROM execution_attempts WHERE id = ?").get(attemptId) as { c: number };
    ok(sqliteRow.c === 0, "A22 SQLite has no such row — no silent fallback");

    const sqliteJob = sqliteRaw.prepare("SELECT COUNT(*) AS c FROM execution_jobs WHERE id = ?").get(jobId) as { c: number };
    ok(sqliteJob.c === 0, "A22 SQLite execution_jobs untouched");

    sqliteRaw.close();
  }

  await pg.close();
  try { mem.close(); } catch {}

  console.log("\n=== Phase 183d runtime consumers Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });