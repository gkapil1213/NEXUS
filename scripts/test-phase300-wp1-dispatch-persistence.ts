// scripts/test-phase300-wp1-dispatch-persistence.ts
// Phase 300 / WP1 - Dispatch persistence integration test.
//
// Exercises the six async dispatch methods on ExecutionStore against a real,
// isolated PostgreSQL database. Isolated database is created and dropped per
// run; no production data is touched.
//
// Requires NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL (a connection
// string whose role has CREATEDB and DROP DATABASE permission). The test
// creates a fresh database `nexus_p300wp1_<random>` from DATABASE_URL, runs
// its assertions, then drops it in a finally block.
//
// Reports PASS / FAIL / BLOCKED per case.
// BLOCKED when the shared backend or its connectivity is unavailable.
// NEVER reports PASS when the DB operation did not actually succeed.

import { randomUUID } from "node:crypto";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import type { RemoteDispatchRecord } from "../src/core/execution-models";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark =
    result === "PASS" ? "[PASS]" :
    result === "FAIL" ? "[FAIL]" :
    result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// `?` placeholders get translated to $1, $2 by PgAsyncEngine.
// The `information_schema` / CREATE DATABASE / DROP DATABASE commands go
// through the base PgClient to avoid the query engine's placeholder logic.

async function pgExec(client: PgClient, sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}

async function createIsolatedDatabase(admin: PgClient, dbName: string): Promise<void> {
  await pgExec(admin, `CREATE DATABASE "${dbName}"`);
}

async function dropIsolatedDatabase(admin: PgClient, dbName: string): Promise<void> {
  try { await pgExec(admin, `DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* best-effort */ }
}

// Minimal schema needed by ExecutionStore's dispatch methods and by the FK
// from remote_dispatches.job_id -> execution_jobs.id. Mirrors pg-bootstrap.ts's
// DDL for these tables but scoped to the isolated database.
async function bootstrapIsolatedSchema(client: PgClient): Promise<void> {
  await pgExec(client, `
    CREATE TABLE execution_jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      job_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL,
      retry_policy TEXT,
      timeout_ms INTEGER,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_attempt_at BIGINT,
      next_attempt_at BIGINT,
      current_lease_id TEXT,
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      cancellation_acknowledged INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pgExec(client, `
    CREATE TABLE remote_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT,
      worker_id TEXT NOT NULL,
      lease_id TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      external_provider_id TEXT,
      request TEXT,
      result TEXT,
      error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES execution_jobs(id)
    )
  `);
}

async function seedJob(client: PgClient, jobId: string): Promise<void> {
  const now = Date.now();
  await pgExec(client,
    "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, " +
    "  retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, " +
    "  next_attempt_at, current_lease_id, cancellation_requested, " +
    "  cancellation_acknowledged, priority) " +
    "VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, " +
    "  NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING",
    [jobId, "idem-job-" + jobId, now],
  );
}

function makeDispatch(opts: {
  dispatchId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  idempotencyKey: string;
  status?: string;
}): RemoteDispatchRecord {
  const now = Date.now();
  return {
    dispatchId: opts.dispatchId,
    jobId: opts.jobId,
    attemptId: undefined,
    workerId: opts.workerId,
    leaseId: opts.leaseId,
    idempotencyKey: opts.idempotencyKey,
    status: opts.status ?? "DISPATCHED",
    createdAt: now,
    updatedAt: now,
  };
}

async function test(
  id: string,
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    record(id, name, "PASS", await fn());
  } catch (e) {
    record(id, name, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

// A fresh ExecutionStore over its own PgClient. Each store instance holds an
// independent pool. Cross-instance visibility therefore genuinely goes through
// the database, not through shared in-process memory.
function makeStore(client: PgClient): ExecutionStore {
  const engine = new PgAsyncEngine(client);
  return new (ExecutionStore as any)({} as any, engine);
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));

  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP1-1","WP1-2","WP1-3","WP1-4","WP1-5","WP1-6","WP1-7","WP1-8"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED",
             "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  const admin = new PgClient();
  const dbName = "nexus_p300wp1_" + randomUUID().replace(/-/g, "").slice(0, 12);
  let isolated: PgClient | null = null;
  let storeA: ExecutionStore | null = null;
  let storeB: ExecutionStore | null = null;
  let storeBClient: PgClient | null = null;

  try {
    await admin.connect(process.env.DATABASE_URL!);
    await createIsolatedDatabase(admin, dbName);
    console.log("  [setup] created isolated database " + dbName);

    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = "/" + dbName;
    isolated = new PgClient();
    await isolated.connect(dbUrl.toString());
    await bootstrapIsolatedSchema(isolated);

    storeA = makeStore(isolated);
    storeBClient = new PgClient();
    await storeBClient.connect(dbUrl.toString());
    storeB = makeStore(storeBClient);

    const store = storeA;
    const storeASecond = storeB;

    // --- WP1-1: Dispatch creation ---------------------------------------
    await test("WP1-1", "createRemoteDispatchIfAbsentAsync creates a new dispatch", async () => {
      const d = "wp1-1-dispatch-" + randomUUID();
      const j = "wp1-1-job-" + randomUUID();
      const l = "wp1-1-lease-" + randomUUID();
      await seedJob(isolated!, j);
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: "idem-wp1-1-" + randomUUID() });
      const out = await store.createRemoteDispatchIfAbsentAsync(rec);
      ok(out.created === true, "expected created=true, got " + JSON.stringify(out));
      const row = await pgExec(isolated!, "SELECT COUNT(*)::int AS n FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(row.rows[0].n === 1, "expected 1 row, got " + row.rows[0].n);
      return "row inserted";
    });

    // --- WP1-2: Dispatch retrieval --------------------------------------
    await test("WP1-2", "getRemoteDispatchAsync returns the exact row", async () => {
      const d = "wp1-2-dispatch-" + randomUUID();
      const j = "wp1-2-job-" + randomUUID();
      const l = "wp1-2-lease-" + randomUUID();
      await seedJob(isolated!, j);
      const key = "idem-wp1-2-" + randomUUID();
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      await store.createRemoteDispatchIfAbsentAsync(rec);
      const got = await store.getRemoteDispatchAsync(d);
      ok(!!got, "getRemoteDispatchAsync returned undefined");
      ok(got!.dispatchId === d, "dispatchId mismatch: " + got!.dispatchId);
      ok(got!.jobId === j, "jobId mismatch: " + got!.jobId);
      ok(got!.workerId === "worker-A", "workerId mismatch");
      ok(got!.idempotencyKey === key, "idempotencyKey mismatch");
      ok(got!.status === "DISPATCHED", "status mismatch: " + got!.status);
      return "read back exact row";
    });

    // --- WP1-3: External provider id retrieval --------------------------
    await test("WP1-3", "getRemoteDispatchByExternalProviderIdAsync returns the same dispatch", async () => {
      const d = "wp1-3-dispatch-" + randomUUID();
      const j = "wp1-3-job-" + randomUUID();
      const l = "wp1-3-lease-" + randomUUID();
      const providerId = "provider-" + randomUUID();
      await seedJob(isolated!, j);
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: "idem-wp1-3-" + randomUUID() });
      await store.createRemoteDispatchIfAbsentAsync(rec);
      // update to set external_provider_id
      const got = await store.getRemoteDispatchAsync(d);
      ok(!!got, "precondition: dispatch missing");
      const updated: RemoteDispatchRecord = { ...got!, externalProviderId: providerId, status: "DISPATCHED", updatedAt: Date.now() };
      await store.upsertRemoteDispatchAsync(updated);
      const byProvider = await store.getRemoteDispatchByExternalProviderIdAsync(providerId);
      ok(!!byProvider, "getRemoteDispatchByExternalProviderIdAsync returned undefined");
      ok(byProvider!.dispatchId === d, "dispatchId mismatch: " + byProvider!.dispatchId);
      return "resolved by provider id";
    });

    // --- WP1-4: Job/idempotency retrieval --------------------------------
    await test("WP1-4", "getRemoteDispatchByJobIdempotencyKeyAsync returns the same dispatch", async () => {
      const d = "wp1-4-dispatch-" + randomUUID();
      const j = "wp1-4-job-" + randomUUID();
      const l = "wp1-4-lease-" + randomUUID();
      const key = "idem-wp1-4-" + randomUUID();
      await seedJob(isolated!, j);
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      await store.createRemoteDispatchIfAbsentAsync(rec);
      const byKey = await store.getRemoteDispatchByJobIdempotencyKeyAsync(key);
      ok(!!byKey, "getRemoteDispatchByJobIdempotencyKeyAsync returned undefined");
      ok(byKey!.dispatchId === d, "dispatchId mismatch: " + byKey!.dispatchId);
      return "resolved by idempotency key";
    });

    // --- WP1-5: Duplicate creation (same dispatch_id) -------------------
    await test("WP1-5", "duplicate creation returns created=false and the original record", async () => {
      const d = "wp1-5-dispatch-" + randomUUID();
      const j = "wp1-5-job-" + randomUUID();
      const l = "wp1-5-lease-" + randomUUID();
      const key = "idem-wp1-5-" + randomUUID();
      await seedJob(isolated!, j);
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      const first = await store.createRemoteDispatchIfAbsentAsync(rec);
      ok(first.created === true, "first create should succeed");
      const second = await store.createRemoteDispatchIfAbsentAsync({ ...rec, status: "DELIVERED", updatedAt: Date.now() });
      ok(second.created === false, "second create should be created=false, got " + JSON.stringify(second));
      ok(second.record.dispatchId === d, "returned dispatchId mismatch: " + second.record.dispatchId);
      ok(second.record.idempotencyKey === key, "returned idempotencyKey mismatch");
      const cnt = await pgExec(isolated!, "SELECT COUNT(*)::int AS n FROM remote_dispatches WHERE idempotency_key = $1", [key]);
      ok(cnt.rows[0].n === 1, "expected 1 row for idempotency key, got " + cnt.rows[0].n);
      return "created=false, original preserved";
    });

    // --- WP1-6: Concurrent creation (same idempotency key) --------------
    await test("WP1-6", "concurrent creation for one idempotency key yields one row and one winner", async () => {
      const d1 = "wp1-6-dispatch-a-" + randomUUID();
      const d2 = "wp1-6-dispatch-b-" + randomUUID();
      const j = "wp1-6-job-" + randomUUID();
      const l = "wp1-6-lease-" + randomUUID();
      const key = "idem-wp1-6-" + randomUUID();
      await seedJob(isolated!, j);
      const a = makeDispatch({ dispatchId: d1, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      const b = makeDispatch({ dispatchId: d2, jobId: j, workerId: "worker-B", leaseId: l, idempotencyKey: key });
      const [ra, rb] = await Promise.all([
        store.createRemoteDispatchIfAbsentAsync(a),
        storeASecond!.createRemoteDispatchIfAbsentAsync(b),
      ]);
      const winners = [ra, rb].filter((x) => x.created).length;
      ok(winners === 1, "expected exactly one winner, got " + winners + " (" + JSON.stringify({ ra, rb }) + ")");
      const cnt = await pgExec(isolated!, "SELECT COUNT(*)::int AS n FROM remote_dispatches WHERE idempotency_key = $1", [key]);
      ok(cnt.rows[0].n === 1, "expected exactly one row, got " + cnt.rows[0].n);
      return "winners=1, rows=1";
    });

    // --- WP1-7: Conflicting idempotency keys (global unique behavior) ---
    // keep-global decision: a second dispatch with a *different* dispatch_id
    // but the *same* idempotency_key cannot coexist. It is rejected by the
    // unique constraint, and createRemoteDispatchIfAbsentAsync returns the
    // original record (created=false).
    await test("WP1-7", "conflicting idempotency_key with different dispatch_id returns the original", async () => {
      const dOriginal = "wp1-7-original-" + randomUUID();
      const dConflict = "wp1-7-conflict-" + randomUUID();
      const j1 = "wp1-7-job-a-" + randomUUID();
      const j2 = "wp1-7-job-b-" + randomUUID();
      const l = "wp1-7-lease-" + randomUUID();
      const key = "idem-wp1-7-" + randomUUID();
      await seedJob(isolated!, j1);
      await seedJob(isolated!, j2);
      const orig = makeDispatch({ dispatchId: dOriginal, jobId: j1, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      const first = await store.createRemoteDispatchIfAbsentAsync(orig);
      ok(first.created === true, "first create should succeed");
      const conflicting = makeDispatch({ dispatchId: dConflict, jobId: j2, workerId: "worker-B", leaseId: l, idempotencyKey: key });
      const second = await store.createRemoteDispatchIfAbsentAsync(conflicting);
      ok(second.created === false, "conflicting create should be created=false, got " + JSON.stringify(second));
      ok(second.record.dispatchId === dOriginal, "conflicting create returned wrong record: " + second.record.dispatchId);
      const cnt = await pgExec(isolated!, "SELECT COUNT(*)::int AS n FROM remote_dispatches WHERE dispatch_id IN ($1, $2)", [dOriginal, dConflict]);
      ok(cnt.rows[0].n === 1, "expected 1 row across both dispatch ids, got " + cnt.rows[0].n);
      return "conflict rejected, original preserved";
    });

    // --- WP1-8: Persistence across independent store instances ----------
    await test("WP1-8", "independent store instance sees a dispatch created by another instance", async () => {
      const d = "wp1-8-dispatch-" + randomUUID();
      const j = "wp1-8-job-" + randomUUID();
      const l = "wp1-8-lease-" + randomUUID();
      const key = "idem-wp1-8-" + randomUUID();
      await seedJob(isolated!, j);
      const rec = makeDispatch({ dispatchId: d, jobId: j, workerId: "worker-A", leaseId: l, idempotencyKey: key });
      const created = await store.createRemoteDispatchIfAbsentAsync(rec);
      ok(created.created === true, "create failed");
      // storeASecond has its own pool; read-through must go to the same DB.
      const observed = await storeASecond!.getRemoteDispatchAsync(d);
      ok(!!observed, "independent store instance returned undefined");
      ok(observed!.dispatchId === d, "dispatchId mismatch");
      ok(observed!.jobId === j, "jobId mismatch");
      ok(observed!.idempotencyKey === key, "idempotencyKey mismatch");
      return "cross-instance read confirmed";
    });

  } finally {
    try { if (storeBClient) await storeBClient.close(); } catch { /* best-effort */ }
    try { if (isolated) await isolated.close(); } catch { /* best-effort */ }
    await dropIsolatedDatabase(admin, dbName);
    console.log("  [cleanup] dropped isolated database " + dbName);
    try { await admin.close(); } catch { /* best-effort */ }
  }
}

main().then(() => {
  const pass = rows.filter(r => r.result === "PASS").length;
  const fail = rows.filter(r => r.result === "FAIL").length;
  const blk  = rows.filter(r => r.result === "BLOCKED").length;
  const ne   = rows.filter(r => r.result === "NOT EXECUTED").length;
  console.log("\n===== Phase 300 WP1 summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
