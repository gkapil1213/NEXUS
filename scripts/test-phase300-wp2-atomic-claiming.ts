import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

async function pgExec(client: PgClient, sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}
async function createDb(admin: PgClient, name: string): Promise<void> { await pgExec(admin, `CREATE DATABASE "${name}"`); }
async function dropDb(admin: PgClient, name: string): Promise<void> { try { await pgExec(admin, `DROP DATABASE IF EXISTS "${name}"`); } catch {} }
async function bootstrap(client: PgClient): Promise<void> {
  await pgExec(client, `CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_attempt_at BIGINT, next_attempt_at BIGINT, current_lease_id TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0, cancellation_acknowledged INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0)`);
  await pgExec(client, `CREATE TABLE remote_dispatches (dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT NOT NULL, lease_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (job_id) REFERENCES execution_jobs(id))`);
}
async function seed(client: PgClient, o: { dispatchId: string; jobId: string; workerId: string; leaseId: string; key: string; }): Promise<void> {
  const now = Date.now();
  await pgExec(client, "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged, priority) VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING", [o.jobId, "idem-job-" + o.jobId, now]);
  await pgExec(client, "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, NULL, $4, 'DISPATCHED', $5, $5, $6) ON CONFLICT (dispatch_id) DO NOTHING", [o.dispatchId, o.jobId, o.workerId, o.leaseId, now, o.key]);
}
function makeStore(client: PgClient): ExecutionStore {
  const engine = new PgAsyncEngine(client);
  return new (ExecutionStore as any)({} as any, engine);
}
function runWorker(workerId: string, dbUrl: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "wp2-claim-worker.ts")], {
      env: { ...process.env, DATABASE_URL: dbUrl, WP2_WORKER_ID: workerId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error("worker " + workerId + " exited " + code + " stderr=" + err)); return; }
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last);
        if (!Array.isArray(parsed.claimed)) { reject(new Error("malformed output: " + last)); return; }
        resolve(parsed.claimed as string[]);
      } catch (e) { reject(new Error("parse error: " + String(e) + " raw=" + last)); }
    });
  });
}
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) { record(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));
  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP2-1","WP2-2","WP2-3","WP2-4","WP2-5","WP2-6"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED", "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }
  const admin = new PgClient();
  const dbName = "nexus_p300wp2_" + randomUUID().replace(/-/g, "").slice(0, 12);
  let isolated: PgClient | null = null;
  let isolatedDbUrl = "";
  try {
    await admin.connect(process.env.DATABASE_URL!);
    await createDb(admin, dbName);
    console.log("  [setup] created isolated database " + dbName);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = "/" + dbName;
    isolatedDbUrl = url.toString();
    isolated = new PgClient();
    await isolated.connect(isolatedDbUrl);
    await bootstrap(isolated);

    await test("WP2-1", "single worker claims a dispatch", async () => {
      const d = "wp2-1-" + randomUUID();
      await seed(isolated!, { dispatchId: d, jobId: "wp2-1-j-" + randomUUID(), workerId: "worker-A", leaseId: "wp2-1-l-" + randomUUID(), key: "idem-wp2-1-" + randomUUID() });
      const store = makeStore(isolated!);
      const rec = await store.claimNextDispatchForWorkerAsync("worker-A");
      ok(!!rec, "expected claim, got undefined");
      ok(rec!.dispatchId === d, "wrong dispatch");
      const st = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(st.rows[0]?.status === "DELIVERED", "status=" + st.rows[0]?.status);
      return "claimed " + d;
    });

    await test("WP2-2", "two in-process workers compete; exactly one wins", async () => {
      const d = "wp2-2-" + randomUUID();
      await seed(isolated!, { dispatchId: d, jobId: "wp2-2-j-" + randomUUID(), workerId: "worker-A", leaseId: "wp2-2-l-" + randomUUID(), key: "idem-wp2-2-" + randomUUID() });
      const a = makeStore(isolated!);
      const b = makeStore(isolated!);
      const [ra, rb] = await Promise.all([a.claimNextDispatchForWorkerAsync("worker-A"), b.claimNextDispatchForWorkerAsync("worker-A")]);
      const claimed = [ra, rb].filter((x) => !!x);
      ok(claimed.length === 1, "expected exactly 1, got " + claimed.length);
      ok(claimed[0]!.dispatchId === d, "wrong dispatch");
      return "one claim, one winner";
    });

    await test("WP2-3", "empty queue returns undefined", async () => {
      const store = makeStore(isolated!);
      const rec = await store.claimNextDispatchForWorkerAsync("worker-empty");
      ok(rec === undefined, "expected undefined, got " + JSON.stringify(rec));
      return "undefined on empty queue";
    });

    await test("WP2-4", "multiple workers claim multiple dispatches, no duplicates", async () => {
      const wA = "wmA-" + randomUUID(), wB = "wmB-" + randomUUID();
      for (let i = 0; i < 4; i++) { const d = "wp2-4a-" + randomUUID(); await seed(isolated!, { dispatchId: d, jobId: "wp2-4a-j-" + randomUUID(), workerId: wA, leaseId: "wp2-4a-l-" + randomUUID(), key: "idem-wp2-4a-" + randomUUID() }); }
      for (let i = 0; i < 4; i++) { const d = "wp2-4b-" + randomUUID(); await seed(isolated!, { dispatchId: d, jobId: "wp2-4b-j-" + randomUUID(), workerId: wB, leaseId: "wp2-4b-l-" + randomUUID(), key: "idem-wp2-4b-" + randomUUID() }); }
      const storeA = makeStore(isolated!), storeB = makeStore(isolated!);
      const cA: string[] = [], cB: string[] = [];
      let more = true;
      while (more) {
        const [a, b] = await Promise.all([storeA.claimNextDispatchForWorkerAsync(wA), storeB.claimNextDispatchForWorkerAsync(wB)]);
        if (a) cA.push(a.dispatchId);
        if (b) cB.push(b.dispatchId);
        more = !!(a || b);
      }
      const all = [...cA, ...cB];
      ok(all.length === 8, "expected 8 claims, got " + all.length);
      ok(new Set(all).size === 8, "expected 8 unique, got " + new Set(all).size);
      const overlap = cA.filter((d) => cB.includes(d));
      ok(overlap.length === 0, "cross-worker overlap: " + overlap.join(","));
      return "8 claims, 8 unique, no cross-worker overlap";
    });

    await test("WP2-5", "two independent PROCESSES compete; every dispatch claimed exactly once", async () => {
      const workerId = "wp-proc-" + randomUUID();
      const N = 20;
      const seeded: string[] = [];
      for (let i = 0; i < N; i++) {
        const d = "wp2-5-" + randomUUID();
        await seed(isolated!, { dispatchId: d, jobId: "wp2-5-j-" + randomUUID(), workerId, leaseId: "wp2-5-l-" + randomUUID(), key: "idem-wp2-5-" + randomUUID() });
        seeded.push(d);
      }
      const [cA, cB] = await Promise.all([runWorker(workerId, isolatedDbUrl), runWorker(workerId, isolatedDbUrl)]);
      const union = [...cA, ...cB];
      ok(new Set(union).size === union.length, "duplicate across processes: " + (union.length - new Set(union).size));
      ok(new Set(union).size === N, "expected " + N + " total, got " + new Set(union).size);
      for (const d of seeded) ok(new Set(union).has(d), "seeded " + d + " not claimed");
      const overlap = cA.filter((d) => cB.includes(d));
      ok(overlap.length === 0, "overlap: " + overlap.join(","));
      return "N=" + N + " A=" + cA.length + " B=" + cB.length + " unique=" + new Set(union).size;
    });

    await test("WP2-6", "claim state durable across fresh store instances", async () => {
      const d = "wp2-6-" + randomUUID();
      await seed(isolated!, { dispatchId: d, jobId: "wp2-6-j-" + randomUUID(), workerId: "worker-A", leaseId: "wp2-6-l-" + randomUUID(), key: "idem-wp2-6-" + randomUUID() });
      const s1 = makeStore(isolated!);
      const r1 = await s1.claimNextDispatchForWorkerAsync("worker-A");
      ok(!!r1, "first claim failed");
      const fresh = new PgClient();
      await fresh.connect(isolatedDbUrl);
      const s2 = makeStore(fresh);
      const st = await pgExec(fresh, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(st.rows[0]?.status === "DELIVERED", "status=" + st.rows[0]?.status);
      const r2 = await s2.claimNextDispatchForWorkerAsync("worker-A");
      ok(r2 === undefined, "re-claimed: " + JSON.stringify(r2));
      await fresh.close();
      return "durable across instances; no re-claim";
    });

  } finally {
    try { if (isolated) await isolated.close(); } catch {}
    await dropDb(admin, dbName);
    console.log("  [cleanup] dropped isolated database " + dbName);
    try { await admin.close(); } catch {}
  }
}

main().then(() => {
  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk = rows.filter(r => r.result === "BLOCKED").length;
  const ne = rows.filter(r => r.result === "NOT EXECUTED").length;
  console.log("\n===== Phase 300 WP2 summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
