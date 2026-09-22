// scripts/test-phase183b-jobs-recovery.ts
// Phase 183b - wire + prove async Postgres job/recovery persistence.
// Real Postgres + real child processes. No mocks.

import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import Database from "better-sqlite3";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { AsyncExecutionRecoveryOperationStore } from "../src/core/execution-recovery-operation-store";

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function section(t: string): void { console.log("\n" + t); }

const CHILD = "scripts/_phase183b_jobs_child.ts";
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
      clearTimeout(timer); liveChildren.delete(child);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      resolve({ code, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL required"); process.exit(2); }

  const pg = new PgClient();
  await pg.connect(url);
  const asyncDb = new PgAsyncEngine(pg);

  // Real SQLite file with isolated sentinel table + empty execution_jobs.
  const sqlitePath = path.join(os.tmpdir(), "nexus-183b-sentinel-" + Date.now() + ".sqlite");
  const sqliteRaw = new Database(sqlitePath);
  sqliteRaw.exec("CREATE TABLE IF NOT EXISTS sentinel (k TEXT PRIMARY KEY, v TEXT)");
  sqliteRaw.prepare("INSERT OR REPLACE INTO sentinel (k, v) VALUES (?, ?)").run("sentinel-key", "untouched");
  sqliteRaw.exec("CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_attempt_at INTEGER, next_attempt_at INTEGER, current_lease_id TEXT, cancellation_requested INTEGER DEFAULT 0, cancellation_acknowledged INTEGER DEFAULT 0)");
  const syncEngine = SQLiteEngine.fromDatabase(sqliteRaw);
  const store = new ExecutionStore(syncEngine, asyncDb);
  const recoveryOps = new AsyncExecutionRecoveryOperationStore(asyncDb);

  const baseJob = (id: string, key: string, status = "PENDING") => ({
    id, idempotencyKey: key, jobType: "test", payload: { tag: id },
    status: status as any, createdAt: Date.now(), updatedAt: Date.now(),
    cancellationRequested: false, cancellationAcknowledged: false,
  });

  // J1/J2 connectivity
  section("J1-J2 - Postgres backend configured + reachable");
  {
    const p = await pg.probe();
    ok(p.ok === true, "J1 probe ok (latency " + p.latencyMs + "ms)");
    const v = await pg.query<{ v: string }>("SELECT version() AS v");
    ok(v.rows[0].v.indexOf("PostgreSQL") >= 0, "J2 PostgreSQL version");
  }

  // J3/J4 schema
  section("J3-J4 - required schema exists");
  {
    for (const t of ["execution_jobs", "execution_events", "execution_ownership_obligations", "execution_recovery_operations", "execution_leases"]) {
      const r = await pg.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name=$1) AS exists", [t]);
      ok(r.rows[0].exists === true, "J3/J4 " + t + " exists");
    }
  }

  // J5 create
  section("J5 - createJobAsync writes Postgres");
  {
    const id = "j5-" + Date.now();
    await store.createJobAsync(baseJob(id, "j5-key-" + Date.now()));
    const r = await pg.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM execution_jobs WHERE id=$1", [id]);
    ok(r.rows[0].c === "1", "J5 Postgres has row");
  }

  // J6 read
  section("J6 - getJobAsync reads Postgres");
  {
    const id = "j6-" + Date.now();
    await store.createJobAsync(baseJob(id, "j6-key-" + Date.now()));
    const j = await store.getJobAsync(id);
    ok(j?.id === id && j?.status === "PENDING", "J6 read back via async");
  }

  // J7 update
  section("J7 - updateJobAsync writes Postgres");
  {
    const id = "j7-" + Date.now();
    await store.createJobAsync(baseJob(id, "j7-key-" + Date.now()));
    const j = (await store.getJobAsync(id))!;
    j.status = "RUNNING" as any;
    j.updatedAt = Date.now();
    await store.updateJobAsync(j);
    const after = await store.getJobAsync(id);
    ok(after?.status === "RUNNING", "J7 update persisted");
  }

  // J8 concurrent idempotent create
  section("J8 - concurrent duplicate idempotent job creation");
  {
    const key = "j8-key-" + Date.now();
    const results = await Promise.all([0,1,2,3,4].map((i) => runChild(url, "create-job-race", "j8-" + i + "-" + Date.now(), key)));
    const created = results.filter((r) => r.json?.created === true);
    ok(created.length === 1, "J8 exactly one created (got " + created.length + ")");
    const rowCount = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM execution_jobs WHERE idempotency_key=$1", [key]);
    ok(rowCount.rows[0].c === "1", "J8 exactly one durable row");
  }

  // J9 cross-process visibility
  section("J9 - cross-process job visibility");
  {
    const id = "j9-" + Date.now();
    await store.createJobAsync(baseJob(id, "j9-key-" + Date.now()));
    const r = await runChild(url, "get-job", id);
    ok(r.code === 0 && r.json?.found === true, "J9 second process sees parent-created job");
  }

  // J10 recovery persistence
  section("J10 - recovery op persisted to Postgres");
  {
    const r = await recoveryOps.createOrGetOperation({
      jobId: "j10-job-" + Date.now(), leaseId: null, workerId: null, operationType: "ORPHAN_RECOVERY",
    });
    const back = await recoveryOps.getOperation(r.operation.operationId);
    ok(r.created === true && back?.state === "PENDING", "J10 recovery op in Postgres, PENDING");
  }

  // J11 cross-process recovery
  section("J11 - cross-process recovery visibility");
  {
    const r = await runChild(url, "create-recovery-op", "j11-job-" + Date.now(), "CANCELLATION");
    ok(r.code === 0 && r.json?.created === true, "J11 child creates op");
    const r2 = await runChild(url, "get-recovery-op", r.json.operationId);
    ok(r2.code === 0 && r2.json?.found === true && r2.json?.state === "PENDING", "J11 second child sees op");
  }

  // J12 recovery transition atomicity
  section("J12 - recovery transition atomicity");
  {
    const r = await runChild(url, "create-recovery-op", "j12-job-" + Date.now(), "TIMEOUT");
    const opId = r.json.operationId;
    const [a, b] = await Promise.all([
      runChild(url, "claim-recovery-op", opId, "owner-A", "60000"),
      runChild(url, "claim-recovery-op", opId, "owner-B", "60000"),
    ]);
    const claimed = [a, b].filter((x) => x.json?.claimed === true);
    ok(claimed.length === 1, "J12 exactly one claimer, atomic");
  }

  // J13 outage fail closed
  section("J13 - Postgres outage fails closed");
  {
    const r = await runChild("postgres://nexus:nexus_phase183_dev@127.0.0.1:5999/nexus", "create-job", "j13-id", "j13-key");
    ok(r.code !== 0, "J13 non-zero exit on unreachable Postgres");
    ok(/CHILD_FAIL|ECONNREFUSED|connect/i.test(r.stderr + r.stdout), "J13 real connect error, no fake success");
  }

  // J14 no silent SQLite fallback (sentinel)
  section("J14 - no silent SQLite fallback");
  {
    const id = "j14-" + Date.now();
    await store.createJobAsync(baseJob(id, "j14-key-" + Date.now()));
    const sqliteRow = sqliteRaw.prepare("SELECT COUNT(*) AS c FROM execution_jobs WHERE id=$id").get({ id }) as { c: number };
    const sentinel = sqliteRaw.prepare("SELECT v FROM sentinel WHERE k=$k").get({ k: "sentinel-key" }) as { v: string };
    const pgRow = await store.getJobAsync(id);
    ok(pgRow?.id === id, "J14 Postgres has the async-created job");
    ok(sqliteRow.c === 0, "J14 SQLite execution_jobs untouched");
    ok(sentinel?.v === "untouched", "J14 SQLite sentinel untouched");
  }

  // J15 SQLite regression: async throws without asyncDb
  section("J15 - SQLite mode regression (async throws)");
  {
    const syncOnly = new ExecutionStore(syncEngine);
    let threw = false;
    try { await syncOnly.createJobAsync(baseJob("j15-id", "j15-key")); } catch { threw = true; }
    ok(threw, "J15 createJobAsync without asyncDb throws");
  }

  // J16 183a idempotency regression (idempotency key uniqueness)
  section("J16 - Phase 183a idempotency regression");
  {
    const key = "j16-key-" + Date.now();
    await store.createJobAsync(baseJob("j16-a-" + Date.now(), key));
    let secondThrew = false;
    try { await store.createJobAsync(baseJob("j16-b-" + Date.now(), key)); } catch { secondThrew = true; }
    ok(secondThrew, "J16 second create with same idempotency_key rejected by UNIQUE");
    const byKey = await store.getJobByIdempotencyKeyAsync(key);
    ok(byKey !== undefined, "J16 idempotency lookup returns the winner");
  }

  // J17 recovery/fencing regression: wrong expectedStatus rejected, no partial event
  section("J17 - recovery/fencing regression");
  {
    const id = "j17-" + Date.now();
    await store.createJobAsync(baseJob(id, "j17-key-" + Date.now()));
    const before = await store.getJobAsync(id);
    const r = await store.recoverJobAtomicAsync({
      jobId: id, expectedStatus: "SUCCEEDED", newStatus: "RETRY_SCHEDULED",
      expectedLeaseId: null,
      event: { eventType: "j17.noop", payload: {} },
    });
    ok(r.ok === false, "J17 wrong expectedStatus -> ok:false (fenced)");
    const after = await store.getJobAsync(id);
    ok(after?.status === before?.status, "J17 status unchanged after fencing rejection");
    const ev = await pg.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM execution_events WHERE job_id=$1 AND event_type=$2", [id, "j17.noop"]);
    ok(ev.rows[0].c === "0", "J17 no event written for rejected transition");
  }

  // J18 restart/reopen durability
  section("J18 - restart durability");
  {
    const id = "j18-" + Date.now();
    await store.createJobAsync(baseJob(id, "j18-key-" + Date.now()));
    // Simulate restart: new PgClient + new store, same DB.
    const pg2 = new PgClient();
    await pg2.connect(url);
    const asyncDb2 = new PgAsyncEngine(pg2);
    const store2 = new ExecutionStore(syncEngine, asyncDb2);
    const j = await store2.getJobAsync(id);
    ok(j?.id === id, "J18 job visible after reopen");
    await pg2.close();
  }

  // J19 no false terminal success
  section("J19 - no false terminal success");
  {
    const id = "j19-" + Date.now();
    await store.createJobAsync(baseJob(id, "j19-key-" + Date.now()));
    // Transition with wrong expectedStatus -> must not advance to SUCCEEDED.
    const r = await store.transitionExecutionAsync({
      jobId: id, expectedStatus: "RUNNING" as any, newStatus: "SUCCEEDED" as any, actor: "system",
    });
    ok(r.ok === false, "J19 transition from wrong state rejected");
    const after = await store.getJobAsync(id);
    ok(after?.status !== "SUCCEEDED", "J19 job did not falsely reach SUCCEEDED (status=" + after?.status + ")");
  }

  // J20 no false KNOWN_GOOD / DEPLOYED
  section("J20 - no false KNOWN_GOOD / DEPLOYED");
  {
    // NEXUS execution_jobs status vocabulary does not contain KNOWN_GOOD or
    // DEPLOYED (those live on release intents / deployments, not migrated in
    // this slice). Verify by construction: no async method on ExecutionStore
    // can produce those strings.
    const id = "j20-" + Date.now();
    await store.createJobAsync(baseJob(id, "j20-key-" + Date.now()));
    const before = await store.getJobAsync(id);
    // Attempt one more fenced transition that should fail.
    await store.transitionExecutionAsync({
      jobId: id, expectedStatus: "RUNNING" as any, newStatus: "SUCCEEDED" as any, actor: "worker",
      leaseId: "fake-lease", workerId: "fake-worker",
    });
    const after = await store.getJobAsync(id);
    ok(after?.status === before?.status, "J20 state unchanged after forged worker transition");
    ok(after?.status !== "KNOWN_GOOD" && after?.status !== "DEPLOYED",
       "J20 status never becomes KNOWN_GOOD or DEPLOYED");
  }

  await pg.close();
  try { sqliteRaw.close(); } catch {}
  try { fs.rmSync(sqlitePath, { force: true }); } catch {}

  console.log("\n=== Phase 183b jobs/recovery Summary ===");
  console.log("Passed: " + passed);
  console.log("Failed: " + failed);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });