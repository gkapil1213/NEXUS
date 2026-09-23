// scripts/test-phase183-final.ts
// Phase 183 final verifier - PostgreSQL shared runtime persistence.
//
// Proves the production worker/lease lifecycle is Postgres-backed in
// shared mode: WorkerRegistry, LeaseManager, ExecutionEngine IO helpers,
// JobDispatcher. Cross-process claims are real (spawn a child connecting
// independently to Postgres). No silent SQLite fallback.
//
// Note on ordering: F18 restarts the postgres container, so it is executed
// after F19 and F20 which still need the pre-restart parent connection.
// All F01-F20 requirements are covered.

import { spawn, execSync, type ChildProcess } from "child_process";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { WorkerRegistry } from "../src/core/worker-registry";
import { LeaseManager } from "../src/core/lease-manager";
import { RetryEngine } from "../src/core/retry-engine";
import { ExecutionEngine } from "../src/core/execution-engine";
import { JobDispatcher } from "../src/core/job-dispatcher";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183_final_child.ts";
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
function mkWorker(id: string, overrides: any = {}): any {
  const now = Date.now();
  return {
    workerId: id, hostname: "test-host", capabilities: ["test-op"],
    status: "ONLINE", lastHeartbeatAt: now, currentJobId: undefined,
    registeredAt: now, ...overrides,
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
  const leaseManager = new LeaseManager(store);
  const registry = new WorkerRegistry(store, leaseManager);

  // ============ F01 ============
  section("F01 - shared runtime configuration");
  {
    const probe = await pg.probe();
    ok(probe.ok === true, "F01 Postgres probe ok");
    ok(store.hasAsyncBackend() === true, "F01 store.hasAsyncBackend() true in shared mode");
    const eng = new ExecutionEngine(store, registry, leaseManager, new RetryEngine(), {} as any);
    ok(eng.hasAsyncPersistence() === true, "F01 ExecutionEngine.hasAsyncPersistence() true");
    ok(process.env.NEXUS_PERSISTENCE_MODE === "shared", "F01 NEXUS_PERSISTENCE_MODE=shared");
  }

  // ============ F02 ============
  const f02Wid = "final-f02-" + Date.now();
  section("F02 - worker registration");
  {
    await registry.registerAsync(mkWorker(f02Wid));
    const r = await pg.query<{ worker_id: string; status: string }>(
      "SELECT worker_id, status FROM execution_workers WHERE worker_id = $1", [f02Wid]);
    ok(r.rows.length === 1, "F02 worker row exists in Postgres");
    ok(r.rows[0]?.status === "ONLINE", "F02 status ONLINE persisted");
  }

  // ============ F03 ============
  section("F03 - cross-process worker visibility");
  {
    const child = await runChild(url, "read-worker", f02Wid);
    ok(child.json?.found === true, "F03 child finds worker row");
    ok(child.json?.worker?.workerId === f02Wid, "F03 worker id matches");
    ok(typeof child.json?.pid === "number" && child.json.pid !== process.pid,
       "F03 read came from a different process");
  }

  // ============ F04 ============
  section("F04 - heartbeat durability");
  {
    const hb = Date.now() + 5000;
    const r = await registry.heartbeatAsync(f02Wid, undefined, { now: hb });
    ok(r.healthy === true, "F04 heartbeat accepted");
    const child = await runChild(url, "read-worker", f02Wid);
    ok(child.json?.worker?.lastHeartbeatAt === hb, "F04 child sees updated lastHeartbeatAt");
  }

  // ============ F05 ============
  section("F05 - worker busy/idle");
  {
    const jobId = "final-f05-job-" + Date.now();
    await registry.markBusyAsync(f02Wid, jobId);
    let child = await runChild(url, "read-worker", f02Wid);
    ok(child.json?.worker?.status === "BUSY", "F05 busy persisted");
    ok(child.json?.worker?.currentJobId === jobId, "F05 currentJobId persisted");
    await registry.markIdleAsync(f02Wid);
    child = await runChild(url, "read-worker", f02Wid);
    ok(child.json?.worker?.status === "ONLINE", "F05 idle persisted");
    ok(!child.json?.worker?.currentJobId, "F05 currentJobId cleared");
  }

  // ============ F06 ============
  const f06JobId = "final-f06-job-" + Date.now();
  let f06LeaseId = "";
  section("F06 - lease acquisition");
  {
    await store.createJobAsync(mkJob(f06JobId));
    const lease = await leaseManager.acquireLeaseAsync(f06JobId, f02Wid, 60_000);
    f06LeaseId = lease.leaseId;
    const r = await pg.query<{ lease_id: string; status: string; worker_id: string }>(
      "SELECT lease_id, status, worker_id FROM execution_leases WHERE lease_id = $1", [f06LeaseId]);
    ok(r.rows.length === 1, "F06 lease row in Postgres");
    ok(r.rows[0]?.status === "ACTIVE", "F06 status ACTIVE");
    ok(r.rows[0]?.worker_id === f02Wid, "F06 worker_id bound");
  }

  // ============ F07 ============
  section("F07 - lease validation");
  {
    ok(await leaseManager.validateLeaseAsync(f06LeaseId, f02Wid) === true, "F07 valid worker+lease succeeds");
  }

  // ============ F08 ============
  section("F08 - wrong worker fence");
  {
    const okV = await leaseManager.validateLeaseAsync(f06LeaseId, "wrong-worker-" + Date.now());
    ok(okV === false, "F08 validateLeaseAsync false for wrong worker");
    let threw = false;
    try { await leaseManager.renewLeaseAsync(f06LeaseId, "wrong-worker", 60_000); }
    catch { threw = true; }
    ok(threw, "F08 renewLeaseAsync throws for wrong worker");
  }

  // ============ F09 ============
  section("F09 - wrong lease fence");
  {
    const wrongLease = "bogus-lease-" + Date.now();
    const v = await leaseManager.validateLeaseAsync(wrongLease, f02Wid);
    ok(v === false, "F09 validateLeaseAsync false for bogus lease");
    const jobId = "final-f09-job-" + Date.now();
    const attemptId = "final-f09-att-" + Date.now();
    const now = Date.now();
    await store.createJobAsync(mkJob(jobId));
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId: wrongLease, workerId: f02Wid,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false && r.reason === "WORKER_OWNERSHIP_LOST", "F09 completeAttempt rejected: WORKER_OWNERSHIP_LOST");
    const att = await store.getAttemptAsync(attemptId);
    ok(att?.status === "RUNNING", "F09 attempt still RUNNING in Postgres");
  }

  // ============ F10 ============
  section("F10 - expired lease fence");
  {
    const expLeaseId = "final-f10-lease-" + Date.now();
    const expJobId = "final-f10-job-" + Date.now();
    const now = Date.now();
    await store.createJobAsync(mkJob(expJobId));
    await pg.query(
      "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, status) VALUES ($1,$2,$3,$4,$5,'ACTIVE')",
      [expLeaseId, expJobId, f02Wid, now - 120_000, now - 60_000],
    );
    const v = await leaseManager.validateLeaseAsync(expLeaseId, f02Wid);
    ok(v === false, "F10 validateLeaseAsync false for expired lease");
    const attemptId = "final-f10-att-" + Date.now();
    await store.createAttemptAsync({ id: attemptId, jobId: expJobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId: expJobId, leaseId: expLeaseId, workerId: f02Wid,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false && r.reason === "WORKER_OWNERSHIP_LOST", "F10 expired lease cannot mutate attempt");
  }

  // ============ F11 ============
  section("F11 - cross-process lease visibility");
  {
    const child = await runChild(url, "read-lease", f06LeaseId);
    ok(child.json?.found === true, "F11 child sees lease row");
    ok(child.json?.lease?.workerId === f02Wid, "F11 worker matches");
    ok(child.json?.lease?.status === "ACTIVE", "F11 status ACTIVE");
  }

  // ============ F12 ============
  section("F12 - lease renewal");
  {
    const before = await pg.query<{ expires_at: string }>(
      "SELECT expires_at FROM execution_leases WHERE lease_id = $1", [f06LeaseId]);
    const expBefore = Number(before.rows[0]?.expires_at);
    await new Promise((r) => setTimeout(r, 50));
    const renewed = await leaseManager.renewLeaseAsync(f06LeaseId, f02Wid, 90_000);
    ok(renewed.expiresAt > expBefore, "F12 renew extends expiresAt");
    const child = await runChild(url, "read-lease", f06LeaseId);
    ok(Number(child.json?.lease?.expiresAt) === renewed.expiresAt, "F12 child sees updated expiresAt");
  }

  // ============ F13 ============
  section("F13 - lease release");
  {
    await leaseManager.releaseLeaseAsync(f06LeaseId);
    const r = await pg.query<{ status: string }>(
      "SELECT status FROM execution_leases WHERE lease_id = $1", [f06LeaseId]);
    ok(r.rows[0]?.status === "RELEASED", "F13 lease status RELEASED");
    const child = await runChild(url, "read-active-lease-for-job", f06JobId);
    ok(child.json?.found === false, "F13 child sees no ACTIVE lease for job");
  }

  // ============ F14 ============
  section("F14 - worker lost detection");
  {
    const staleWid = "final-f14-" + Date.now();
    await registry.registerAsync(mkWorker(staleWid, { lastHeartbeatAt: Date.now() - 300_000, status: "ONLINE" }));
    const lost = await registry.detectLostWorkersAsync(Date.now(), 120_000);
    ok(lost.find((w) => w.workerId === staleWid) !== undefined, "F14 stale worker detected");
  }

  // ============ F15 ============
  section("F15 - runtime dispatch integration");
  {
    const dJobId = "final-f15-job-" + Date.now();
    const dWid = "final-f15-worker-" + Date.now();
    await store.createJobAsync(mkJob(dJobId));
    await registry.registerAsync(mkWorker(dWid, { capabilities: ["test-op"] }));
    const remoteStub: any = {
      async dispatch(_req: any, _wid: string, _lid: string) { return { dispatchId: "stub-" + Date.now() }; },
    };
    const dispatcher = new JobDispatcher(registry, remoteStub, store, leaseManager);
    const dispatchId = await dispatcher.dispatchJob(dJobId, dWid, { operation: "test-op" } as any);
    ok(typeof dispatchId === "string" && dispatchId.length > 0, "F15 dispatchJob returned dispatchId");
    const wr = await pg.query<{ status: string; current_job_id: string }>(
      "SELECT status, current_job_id FROM execution_workers WHERE worker_id = $1", [dWid]);
    ok(wr.rows[0]?.status === "BUSY", "F15 worker marked BUSY in Postgres");
    ok(wr.rows[0]?.current_job_id === dJobId, "F15 current_job_id bound in Postgres");
    const lr = await pg.query<{ status: string }>(
      "SELECT status FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [dJobId]);
    ok(lr.rows.length === 1, "F15 ACTIVE lease row in Postgres");
  }

  // ============ F16 ============
  section("F16 - no silent SQLite fallback");
  {
    const uWid = "final-f16-" + Date.now();
    await registry.registerAsync(mkWorker(uWid));
    const inPg = await pg.query<{ worker_id: string }>(
      "SELECT worker_id FROM execution_workers WHERE worker_id = $1", [uWid]);
    ok(inPg.rows.length === 1, "F16 worker row exists in Postgres");

    // If SQLite schema was never created, the read throws "no such table" --
    // that is stronger evidence of no-fallback than a "row not found" result.
    let sqliteWorkerMissing = false;
    let sqliteWorkerReason = "";
    try {
      sqliteWorkerMissing = (store.getWorker(uWid) === undefined);
      sqliteWorkerReason = sqliteWorkerMissing ? "row absent" : "row present (FAIL)";
    } catch (e: any) {
      if (/no such table/i.test(String(e?.message))) {
        sqliteWorkerMissing = true;
        sqliteWorkerReason = "sqlite table not created (never written)";
      } else { throw e; }
    }
    ok(sqliteWorkerMissing, "F16 worker NOT in local SQLite - " + sqliteWorkerReason);

    const uJobId = "final-f16-job-" + Date.now();
    await store.createJobAsync(mkJob(uJobId));
    const uLease = await leaseManager.acquireLeaseAsync(uJobId, uWid, 60_000);

    let sqliteLeaseMissing = false;
    let sqliteLeaseReason = "";
    try {
      sqliteLeaseMissing = (store.getLease(uLease.leaseId) === undefined);
      sqliteLeaseReason = sqliteLeaseMissing ? "row absent" : "row present (FAIL)";
    } catch (e: any) {
      if (/no such table/i.test(String(e?.message))) {
        sqliteLeaseMissing = true;
        sqliteLeaseReason = "sqlite table not created (never written)";
      } else { throw e; }
    }
    ok(sqliteLeaseMissing, "F16 lease NOT in local SQLite - " + sqliteLeaseReason);
  }

  // ============ F17 ============
  section("F17 - local mode compatibility");
  {
    const localMem = new Database(":memory:");
    const localSync = SQLiteEngine.fromDatabase(localMem);
    const localStore = new ExecutionStore(localSync);
    ok(localStore.hasAsyncBackend() === false, "F17 hasAsyncBackend false in local mode");
    let asyncThrew = false;
    try { await localStore.registerWorkerAsync(mkWorker("x")); } catch { asyncThrew = true; }
    ok(asyncThrew, "F17 async method throws without asyncDb");
    localMem.close();
  }

  // ============ F19 ============
  section("F19 - ownership safety");
  {
    const jobId = "final-f19-job-" + Date.now();
    const attemptId = "final-f19-att-" + Date.now();
    const now = Date.now();
    await store.createJobAsync(mkJob(jobId));
    await store.createAttemptAsync({ id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", createdAt: now, startedAt: now } as any);
    const r = await store.completeAttemptAndTransitionJobAsync({
      attemptId, jobId, leaseId: "nonexistent-" + now, workerId: f02Wid,
      attemptStatus: "SUCCEEDED", expectedJobStatus: "RUNNING", newJobStatus: "SUCCEEDED",
    });
    ok(r.ok === false && r.reason === "WORKER_OWNERSHIP_LOST", "F19 invalid lease cannot complete attempt");
    ok((await store.getAttemptAsync(attemptId))?.status === "RUNNING", "F19 attempt unchanged");
    ok((await store.getJobAsync(jobId))?.status === "RUNNING", "F19 job unchanged");
  }

  // ============ F20 ============
  section("F20 - clean shutdown/recovery behavior");
  {
    const sWid = "final-f20-worker-" + Date.now();
    const sJobId = "final-f20-job-" + Date.now();
    await registry.registerAsync(mkWorker(sWid));
    await store.createJobAsync(mkJob(sJobId));
    const sLease = await leaseManager.acquireLeaseAsync(sJobId, sWid, 60_000);
    const active = await pg.query<{ status: string }>(
      "SELECT status FROM execution_leases WHERE lease_id = $1", [sLease.leaseId]);
    ok(active.rows[0]?.status === "ACTIVE", "F20 lease ACTIVE before release");
    await leaseManager.releaseLeaseAsync(sLease.leaseId);
    const after = await pg.query<{ status: string }>(
      "SELECT status FROM execution_leases WHERE lease_id = $1", [sLease.leaseId]);
    ok(after.rows[0]?.status === "RELEASED", "F20 lease RELEASED");
    const jobAfter = await pg.query<{ current_lease_id: string | null }>(
      "SELECT current_lease_id FROM execution_jobs WHERE id = $1", [sJobId]);
    ok(jobAfter.rows[0]?.current_lease_id === null, "F20 current_lease_id cleared");
    const activeLeft = await pg.query<{ lease_id: string }>(
      "SELECT lease_id FROM execution_leases WHERE job_id = $1 AND status = 'ACTIVE'", [sJobId]);
    ok(activeLeft.rows.length === 0, "F20 no ACTIVE lease rows left for job");
    await registry.drainAsync(sWid);
    let wr = await pg.query<{ status: string }>(
      "SELECT status FROM execution_workers WHERE worker_id = $1", [sWid]);
    ok(wr.rows[0]?.status === "DRAINING", "F20 worker DRAINING persisted");
    await registry.unregisterAsync(sWid);
    wr = await pg.query<{ status: string }>(
      "SELECT status FROM execution_workers WHERE worker_id = $1", [sWid]);
    ok(wr.rows[0]?.status === "OFFLINE", "F20 worker OFFLINE persisted");
  }

  // ============ F18 (executed last - restarts postgres) ============
  section("F18 - PostgreSQL restart durability");
  {
    const rWid = "final-f18-worker-" + Date.now();
    const rJobId = "final-f18-job-" + Date.now();
    await registry.registerAsync(mkWorker(rWid));
    await store.createJobAsync(mkJob(rJobId));
    const rLease = await leaseManager.acquireLeaseAsync(rJobId, rWid, 300_000);
    const before = await pg.query<{ worker_id: string }>(
      "SELECT worker_id FROM execution_workers WHERE worker_id = $1", [rWid]);
    ok(before.rows.length === 1, "F18 worker present before restart");

    // Close the parent pool BEFORE restart. Otherwise postgres sends FATAL
    // 57P01 "terminating connection due to administrator command" to the
    // idle client and pg-pool emits an unhandled 'error' event.
    try { await pg.close(); } catch { /* ignore */ }

    let restartErr: string | null = null;
    try { execSync("docker restart nexus-phase183-postgres", { stdio: "pipe", timeout: 60_000 }); }
    catch (e) { restartErr = (e as Error).message; }
    ok(restartErr === null, "F18 docker restart executed without error");

    // Wait for the container to accept new connections again, then verify
    // durability via child processes (each opens its own fresh connection).
    let reconnected = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const p2 = new PgClient();
        await p2.connect(url);
        const probe = await p2.probe();
        await p2.close();
        if (probe.ok) { reconnected = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    ok(reconnected, "F18 postgres reachable after restart");

    const wChild = await runChild(url, "read-worker", rWid);
    ok(wChild.json?.found === true, "F18 worker row survived restart (child read)");
    const lChild = await runChild(url, "read-lease", rLease.leaseId);
    ok(lChild.json?.found === true, "F18 lease row survived restart (child read)");
    ok(lChild.json?.lease?.status === "ACTIVE", "F18 lease status preserved");
  }

  try { await pg.close(); } catch {}
  try { mem.close(); } catch {}

  console.log("\n=== Phase 183 final Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });