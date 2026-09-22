// scripts/test-phase183c-attempts-workers.ts
// Phase 183c - attempts + workers persistence over real Postgres.
// A01-A20. Real Postgres, real child processes.

import { spawn, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183c_attempts_child.ts";
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

function mkJob(id: string): any {
  const now = Date.now();
  return {
    id, idempotencyKey: "ck-" + id, jobType: "engineering",
    payload: { kind: "engineering" }, status: "RUNNING",
    createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  };
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

  // ============================================================
  // A01-A02 Schema
  // ============================================================
  section("A01-A02 - Postgres schema");
  {
    const ta = await pg.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='execution_attempts' AND table_schema='public') AS exists");
    ok(ta.rows[0]?.exists === true, "A01 execution_attempts exists");
    const tw = await pg.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='execution_workers' AND table_schema='public') AS exists");
    ok(tw.rows[0]?.exists === true, "A02 execution_workers exists");
  }

  // ============================================================
  // A03-A05 createAttemptAsync / get / list
  // ============================================================
  section("A03-A05 - createAttemptAsync");
  {
    const jobId = "ck-job-a03-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const attemptId = "ck-attempt-a03-" + Date.now();
    const now = Date.now();
    await store.createAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING",
      createdAt: now, startedAt: now,
    } as any);

    const back = await store.getAttemptAsync(attemptId);
    ok(back?.id === attemptId && back?.status === "RUNNING", "A03 createAttemptAsync round-trip");

    const list = await store.listAttemptsForJobAsync(jobId);
    ok(list.length === 1 && list[0].id === attemptId, "A04 listAttemptsForJobAsync returns it");

    const fromPg = await pg.query<{ id: string; status: string }>(
      "SELECT id, status FROM execution_attempts WHERE id = $1", [attemptId]);
    ok(fromPg.rows[0]?.id === attemptId, "A05 Postgres has the attempt row");
  }

  // ============================================================
  // A06-A08 createAttemptAsOwnerAsync (fenced)
  // ============================================================
  section("A06-A08 - createAttemptAsOwnerAsync");
  {
    const jobId = "ck-job-a06-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a06-" + Date.now();
    const now = Date.now();
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, "w-A06", now, now + 60_000]);

    // no lease held → rejected
    const reject = await store.createAttemptAsOwnerAsync({
      id: "ck-a06-r-" + Date.now(), jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any, "ck-lease-bogus", "w-A06", now);
    ok(reject.created === false && reject.reason === "WORKER_OWNERSHIP_LOST", "A06 rejected without active lease");

    // with lease → succeeds
    const attemptId = "ck-a06-ok-" + Date.now();
    const okr = await store.createAttemptAsOwnerAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any, leaseId, "w-A06", now);
    ok(okr.created === true, "A07 accepted with active lease");

    // PK collision → created:false (idempotent)
    const dup = await store.createAttemptAsOwnerAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any, leaseId, "w-A06", now);
    ok(dup.created === false, "A08 duplicate id returns created:false");
  }

  // ============================================================
  // A09-A11 createAttemptAsOwnerAtomicAsync
  // ============================================================
  section("A09-A11 - createAttemptAsOwnerAtomicAsync");
  {
    const jobId = "ck-job-a09-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a09-" + Date.now();
    const now = Date.now();
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, "w-A09", now, now + 60_000]);

    const r1 = await store.createAttemptAsOwnerAtomicAsync(jobId, leaseId, "w-A09", "RUNNING" as any, now);
    ok(r1.created === true && r1.attempt?.attemptNumber === 1, "A09 first atomic attempt number=1");

    const r2 = await store.createAttemptAsOwnerAtomicAsync(jobId, leaseId, "w-A09", "RUNNING" as any, now);
    // idempotent: existing RUNNING for same lease returned as-is (created:true, same attempt)
    ok(r2.created === true && r2.attempt?.id === r1.attempt?.id, "A09 second call idempotent");

    // Terminal job rejected
    const termJobId = "ck-job-a10-" + Date.now();
    await store.createJobAsync(mkJob(termJobId));
    const termLeaseId = "ck-lease-a10-" + Date.now();
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [termLeaseId, termJobId, "w-A10", now, now + 60_000]);
    await pg.query("UPDATE execution_jobs SET status='SUCCEEDED' WHERE id=$1", [termJobId]);
    const termResult = await store.createAttemptAsOwnerAtomicAsync(termJobId, termLeaseId, "w-A10", "RUNNING" as any, now);
    ok(termResult.created === false && termResult.reason === "TERMINAL_STATE", "A10 terminal job rejected");

    // Cancel-requested job rejected
    const cancelJobId = "ck-job-a11-" + Date.now();
    await store.createJobAsync(mkJob(cancelJobId));
    const cancelLeaseId = "ck-lease-a11-" + Date.now();
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [cancelLeaseId, cancelJobId, "w-A11", now, now + 60_000]);
    await pg.query("UPDATE execution_jobs SET cancellation_requested=1 WHERE id=$1", [cancelJobId]);
    const cancelResult = await store.createAttemptAsOwnerAtomicAsync(cancelJobId, cancelLeaseId, "w-A11", "RUNNING" as any, now);
    ok(cancelResult.created === false && cancelResult.reason === "CANCELLATION_REQUESTED", "A11 cancel-requested job rejected");
  }

  // ============================================================
  // A12-A13 updateAttemptAsOwnerAsync
  // ============================================================
  section("A12-A13 - updateAttemptAsOwnerAsync");
  {
    const jobId = "ck-job-a12-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const leaseId = "ck-lease-a12-" + Date.now();
    const now = Date.now();
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [leaseId, jobId, "w-A12", now, now + 60_000]);

    const attemptId = "ck-a12-" + Date.now();
    await store.createAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now,
    } as any);

    // wrong lease → rejected
    const stale = await store.updateAttemptAsOwnerAsync(
      { id: attemptId, jobId, attemptNumber: 1, status: "SUCCEEDED", createdAt: now } as any,
      leaseId, "w-WRONG", now);
    ok(stale.updated === false, "A12 rejected with wrong workerId");

    // correct lease → succeeds
    const okr = await store.updateAttemptAsOwnerAsync(
      { id: attemptId, jobId, attemptNumber: 1, status: "SUCCEEDED", createdAt: now, completedAt: now } as any,
      leaseId, "w-A12", now);
    ok(okr.updated === true && okr.applied === true, "A13 accepted with correct owner");

    const back = await store.getAttemptAsync(attemptId);
    ok(back?.status === "SUCCEEDED", "A13 status updated durably");
  }

  // ============================================================
  // A14 updateAttemptAsync (unfenced)
  // ============================================================
  section("A14 - updateAttemptAsync");
  {
    const jobId = "ck-job-a14-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const attemptId = "ck-a14-" + Date.now();
    const now = Date.now();
    await store.createAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any);

    await store.updateAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "FAILED",
      error: "test-error", createdAt: now, completedAt: now,
    } as any);
    const back = await store.getAttemptAsync(attemptId);
    ok(back?.status === "FAILED" && back?.error === "test-error", "A14 updateAttemptAsync applies");
  }

  // ============================================================
  // A15-A17 workers CRUD
  // ============================================================
  section("A15-A17 - workers CRUD");
  {
    const workerId = "ck-worker-a15-" + Date.now();
    const now = Date.now();
    await store.registerWorkerAsync({
      workerId, hostname: "ck-host", status: "IDLE",
      registeredAt: now, lastHeartbeatAt: now,
    } as any);

    const back = await store.getWorkerAsync(workerId);
    ok(back?.workerId === workerId && back?.status === "IDLE", "A15 register + get round-trip");

    await store.updateWorkerAsync({
      workerId, hostname: "ck-host", status: "BUSY",
      registeredAt: now, lastHeartbeatAt: now + 1000, currentJobId: "ck-job-x",
    } as any);
    const updated = await store.getWorkerAsync(workerId);
    ok(updated?.status === "BUSY" && updated?.currentJobId === "ck-job-x", "A16 updateWorkerAsync applies");

    const all = await store.listWorkersAsync();
    ok(all.some((w) => w.workerId === workerId), "A17 listWorkersAsync includes it");

    const busy = await store.listWorkersByStatusAsync("BUSY");
    ok(busy.some((w) => w.workerId === workerId), "A17 listWorkersByStatusAsync filters correctly");
  }

  // ============================================================
  // A18 Cross-process visibility
  // ============================================================
  section("A18 - cross-process visibility");
  {
    const jobId = "ck-job-a18-" + Date.now();
    const jobRes = await runChild(url, "create-job", jobId);
    ok(jobRes.code === 0 && jobRes.json?.ok === true, "A18 child created job");

    const attemptId = "ck-a18-" + Date.now();
    const attemptRes = await runChild(url, "create-attempt", attemptId, jobId, "1");
    ok(attemptRes.code === 0 && attemptRes.json?.ok === true, "A18 child created attempt");

    const fromParent = await store.getAttemptAsync(attemptId);
    ok(fromParent?.id === attemptId, "A18 parent reads child-created attempt");

    const readBack = await runChild(url, "get-attempt", attemptId);
    ok(readBack.code === 0 && readBack.json?.found === true, "A18 second child reads same attempt");

    const workerId = "ck-worker-a18-" + Date.now();
    const regRes = await runChild(url, "register-worker", workerId);
    ok(regRes.code === 0 && regRes.json?.ok === true, "A18 child registered worker");

    const workerFromParent = await store.getWorkerAsync(workerId);
    ok(workerFromParent?.workerId === workerId, "A18 parent reads child-registered worker");
  }

  // ============================================================
  // A19 Restart durability
  // ============================================================
  section("A19 - restart durability");
  {
    const jobId = "ck-job-a19-" + Date.now();
    await store.createJobAsync(mkJob(jobId));
    const attemptId = "ck-a19-" + Date.now();
    const now = Date.now();
    await store.createAttemptAsync({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any);

    const pg2 = new PgClient();
    await pg2.connect(url);
    const asyncDb2 = new PgAsyncEngine(pg2);
    const store2 = new ExecutionStore(syncEngine, asyncDb2);
    const after = await store2.getAttemptAsync(attemptId);
    ok(after?.id === attemptId, "A19 attempt visible after restart");
    ok(after?.status === "RUNNING", "A19 status survived restart");
    await pg2.close();
  }

  // ============================================================
  // A20 SQLite-mode compatibility
  // ============================================================
  section("A20 - SQLite compatibility");
  {
    const mem2 = new Database(":memory:");
    const syncEngine2 = SQLiteEngine.fromDatabase(mem2);
    const { MigrationRunner } = await import("../src/core/migration-runner");
    const { join } = await import("path");
    new MigrationRunner(mem2, join(process.cwd(), "src", "db", "migrations")).run();
    mem2.exec(`CREATE TABLE IF NOT EXISTS nexus_records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`);
    const store2 = new ExecutionStore(syncEngine2);

    ok(store2.hasAsyncBackend() === false, "A20 hasAsyncBackend() false");
    let threw = false;
    try { await store2.getAttemptAsync("nope"); } catch { threw = true; }
    ok(threw, "A20 async method throws without asyncDb");

    // Sync path works
    const jobId = "ck-job-a20-" + Date.now();
    store2.createJob(mkJob(jobId));
    const attemptId = "ck-a20-" + Date.now();
    const now = Date.now();
    store2.createAttempt({
      id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now,
    } as any);
    const back = store2.getAttempt(attemptId);
    ok(back?.id === attemptId, "A20 sync createAttempt + getAttempt works");

    mem2.close();
  }

  await pg.close();
  try { mem.close(); } catch {}

  console.log("\n=== Phase 183c attempts/workers Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });