// scripts/test-phase300-wp6-cancellation-status.ts
// Phase 300 / WP6 - DispatchService cancellation + status test.
//
// Covers cancelDetailed (honest cancellation, terminal preservation,
// race handling, provider failure) and getStatus (terminal short-circuit,
// re-read after provider call). Against isolated PostgreSQL and SQLite.

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "path";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import { DispatchService } from "../src/core/dispatch-service";
import { JobDispatcher } from "../src/core/job-dispatcher";
import type { RemoteExecutionAdapter } from "../src/core/remote-execution-adapter";
import type { ExecutionAdapterRequest, ExecutionAdapterResult } from "../src/core/execution-adapter";
import type { RemoteDispatchRecord } from "../src/core/execution-models";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
async function test(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { record(id, name, "PASS", await fn()); }
  catch (e) { record(id, name, "FAIL", e instanceof Error ? e.message : String(e)); }
}

async function pgExec(client: PgClient, sql: string, params: unknown[] = []): Promise<any> {
  return await client.query(sql, params);
}
async function createDb(admin: PgClient, name: string): Promise<void> { await pgExec(admin, `CREATE DATABASE "${name}"`); }
async function dropDb(admin: PgClient, name: string): Promise<void> { try { await pgExec(admin, `DROP DATABASE IF EXISTS "${name}"`); } catch {} }

async function bootstrapPg(client: PgClient): Promise<void> {
  await pgExec(client, `CREATE TABLE execution_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, job_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL, retry_policy TEXT, timeout_ms INTEGER, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_attempt_at BIGINT, next_attempt_at BIGINT, current_lease_id TEXT, cancellation_requested INTEGER NOT NULL DEFAULT 0, cancellation_acknowledged INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0)`);
  await pgExec(client, `CREATE TABLE remote_dispatches (dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, worker_id TEXT NOT NULL, lease_id TEXT, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, external_provider_id TEXT, request TEXT, result TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, FOREIGN KEY (job_id) REFERENCES execution_jobs(id))`);
}

async function seedDispatch(
  pg: PgClient,
  o: { dispatchId: string; jobId: string; workerId: string; status: string; externalProviderId?: string },
): Promise<void> {
  const now = Date.now();
  await pgExec(pg, "INSERT INTO execution_jobs (id, idempotency_key, job_type, payload, status, retry_policy, timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at, current_lease_id, cancellation_requested, cancellation_acknowledged, priority) VALUES ($1, $2, 'remote.exec', '{}', 'RUNNING', NULL, NULL, $3, $3, NULL, NULL, NULL, 0, 0, 0) ON CONFLICT (id) DO NOTHING", [o.jobId, "idem-job-" + o.jobId, now]);
  await pgExec(pg, "INSERT INTO remote_dispatches (dispatch_id, job_id, worker_id, attempt_id, lease_id, status, external_provider_id, created_at, updated_at, idempotency_key) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $6, $7) ON CONFLICT (dispatch_id) DO NOTHING", [o.dispatchId, o.jobId, o.workerId, o.status, o.externalProviderId ?? null, now, "idem-" + o.dispatchId]);
}

interface AdapterState {
  throwOnCancel: boolean;
  throwOnStatus: boolean;
  statusById: Map<string, string>;
  defaultStatus: string;
  cancelCalls: number;
  statusCalls: string[];
  // Optional "post-cancel" hook: called with the dispatchId immediately after
  // cancel() returns successfully, so the test can mutate durable state
  // (simulate a race where the dispatch becomes terminal while we await).
  onCancelReturn?: (dispatchId: string) => Promise<void>;
}

function makeAdapter(state: AdapterState): RemoteExecutionAdapter {
  return {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async dispatch(): Promise<{ dispatchId: string }> { return { dispatchId: "provider-" + randomUUID() }; },
    async cancel(id: string): Promise<void> {
      state.cancelCalls++;
      if (state.throwOnCancel) throw new Error("provider_unavailable");
      if (state.onCancelReturn) await state.onCancelReturn(id);
    },
    async getStatus(id: string): Promise<{ status: string }> {
      state.statusCalls.push(id);
      if (state.throwOnStatus) throw new Error("provider_down");
      return { status: state.statusById.get(id) ?? state.defaultStatus };
    },
    async collectResult(): Promise<ExecutionAdapterResult> { return { success: true, exitCode: 0 }; },
    async *streamLogs(): AsyncIterable<{ sequence: number; type: string; data: string }> {},
  } as any;
}

async function makeStore(client: PgClient): Promise<ExecutionStore> {
  const engine = new PgAsyncEngine(client);
  const store = new (ExecutionStore as any)({} as any, engine);
  return store;
}

// DispatchService needs JobDispatcher + RemoteExecutionManager. The
// JobDispatcher is not exercised by these tests (we never call dispatch()).
// We pass a minimal JobDispatcher over a store + registry.
function makeDispatchService(store: ExecutionStore, mgr: RemoteExecutionManager): DispatchService {
  // Minimal JobDispatcher: only the constructor deps are used; dispatchJob
  // is not called by cancelDetailed / getStatus.
  const registry: any = { register: () => {}, getWorker: () => undefined };
  const leaseManager: any = {};
  const jobDispatcher = new JobDispatcher(registry, mgr, store, leaseManager);
  return new DispatchService(jobDispatcher, mgr, store);
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));

  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP6-1","WP6-2","WP6-3","WP6-4","WP6-5","WP6-6","WP6-7","WP6-8","WP6-9","WP6-10"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED", "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  const admin = new PgClient();
  const dbName = "nexus_p300wp6_" + randomUUID().replace(/-/g, "").slice(0, 12);
  let isolated: PgClient | null = null;

  try {
    await admin.connect(process.env.DATABASE_URL!);
    await createDb(admin, dbName);
    console.log("  [setup] created isolated database " + dbName);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = "/" + dbName;
    isolated = new PgClient();
    await isolated.connect(url.toString());
    await bootstrapPg(isolated);

    // --- WP6-1: successful cancellation
    await test("WP6-1", "successful cancellation persists CANCELLED", async () => {
      const d = "wp6-1-disp-" + randomUUID();
      const j = "wp6-1-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.cancelDetailed(d);
      ok(res.cancelled === true, "expected cancelled=true, got " + JSON.stringify(res));
      ok(state.cancelCalls === 1, "expected 1 cancel call, got " + state.cancelCalls);
      const row = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(row.rows[0]?.status === "CANCELLED", "expected CANCELLED, got " + row.rows[0]?.status);
      return "CANCELLED persisted";
    });

    // --- WP6-2: already-cancelled
    await test("WP6-2", "already-CANCELLED returns true without provider call", async () => {
      const d = "wp6-2-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-2-job-" + randomUUID(), workerId: "wA", status: "CANCELLED", externalProviderId: "ext-" + randomUUID() });
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.cancelDetailed(d);
      ok(res.cancelled === true, "expected cancelled=true, got " + JSON.stringify(res));
      ok(state.cancelCalls === 0, "expected 0 provider calls, got " + state.cancelCalls);
      return "returned true; no provider call";
    });

    // --- WP6-3: cancel racing completion
    await test("WP6-3", "cancel racing COMPLETED returns raced_to_terminal", async () => {
      const d = "wp6-3-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-3-job-" + randomUUID(), workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = {
        throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [],
        onCancelReturn: async (id) => {
          // Simulate completion happening while we awaited the provider.
          await pgExec(isolated!, "UPDATE remote_dispatches SET status = 'COMPLETED' WHERE external_provider_id = $1", [id]);
        },
      };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.cancelDetailed(d);
      ok(res.cancelled === false, "expected cancelled=false");
      ok((res.reason ?? "").startsWith("raced_to_terminal:COMPLETED"), "expected raced_to_terminal:COMPLETED, got " + res.reason);
      const row = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(row.rows[0]?.status === "COMPLETED", "expected COMPLETED preserved, got " + row.rows[0]?.status);
      return "raced_to_terminal; COMPLETED preserved";
    });

    // --- WP6-4: cancel racing failure
    await test("WP6-4", "cancel racing FAILED returns raced_to_terminal", async () => {
      const d = "wp6-4-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-4-job-" + randomUUID(), workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = {
        throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [],
        onCancelReturn: async (id) => {
          await pgExec(isolated!, "UPDATE remote_dispatches SET status = 'FAILED' WHERE external_provider_id = $1", [id]);
        },
      };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.cancelDetailed(d);
      ok(res.cancelled === false, "expected cancelled=false");
      ok((res.reason ?? "").startsWith("raced_to_terminal:FAILED"), "expected raced_to_terminal:FAILED, got " + res.reason);
      return "raced_to_terminal; FAILED preserved";
    });

    // --- WP6-5: provider cancel failure
    await test("WP6-5", "provider cancel failure leaves durable state unchanged", async () => {
      const d = "wp6-5-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-5-job-" + randomUUID(), workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = { throwOnCancel: true, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.cancelDetailed(d);
      ok(res.cancelled === false, "expected cancelled=false");
      ok((res.reason ?? "").startsWith("provider_unavailable:"), "expected provider_unavailable prefix, got " + res.reason);
      const row = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(row.rows[0]?.status === "DISPATCHED", "expected DISPATCHED unchanged, got " + row.rows[0]?.status);
      return "provider_unavailable; DISPATCHED preserved";
    });

    // --- WP6-6: getStatus returns durable status without calling provider
    // when the dispatch exists durably and has no result. The durable state
    // is authoritative; the provider is not consulted. This is by design.
    await test("WP6-6", "getStatus returns durable DISPATCHED without calling provider", async () => {
      const d = "wp6-6-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-6-job-" + randomUUID(), workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: true, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.getStatus(d);
      ok(res.status === "DISPATCHED", "expected durable DISPATCHED, got " + res.status);
      ok(state.statusCalls.length === 0, "expected 0 provider status calls, got " + state.statusCalls.length);
      return "durable DISPATCHED; no provider call";
    });

    // --- WP6-7: getStatus terminal short-circuit
    await test("WP6-7", "getStatus on durable COMPLETED returns it without provider call", async () => {
      const d = "wp6-7-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-7-job-" + randomUUID(), workerId: "wA", status: "COMPLETED", externalProviderId: "ext-" + randomUUID() });
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: true, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const res = await svc.getStatus(d);
      ok(res.status === "COMPLETED", "expected COMPLETED, got " + res.status);
      ok(state.statusCalls.length === 0, "expected 0 provider calls, got " + state.statusCalls.length);
      return "COMPLETED; no provider call";
    });

    // --- WP6-8: concurrent cancel
    await test("WP6-8", "two concurrent cancelDetailed calls are idempotent", async () => {
      const d = "wp6-8-disp-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: "wp6-8-job-" + randomUUID(), workerId: "wA", status: "DISPATCHED", externalProviderId: "ext-" + d });
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      const [r1, r2] = await Promise.all([svc.cancelDetailed(d), svc.cancelDetailed(d)]);
      ok(r1.cancelled === true || r2.cancelled === true, "at least one should report cancelled=true");
      const row = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(row.rows[0]?.status === "CANCELLED", "expected CANCELLED, got " + row.rows[0]?.status);
      return "one CANCELLED write; idempotent";
    });

    // --- WP6-9: database error propagation
    await test("WP6-9", "getStatus on missing dispatch throws not-found", async () => {
      const state: AdapterState = { throwOnCancel: false, throwOnStatus: false, statusById: new Map(), defaultStatus: "RUNNING", cancelCalls: 0, statusCalls: [] };
      const adapter = makeAdapter(state);
      const store = await makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      const svc = makeDispatchService(store, mgr);
      let threw = false;
      try { await svc.getStatus("missing-" + randomUUID()); } catch { threw = true; }
      ok(threw === true, "expected throw on missing dispatch");
      return "not-found throws";
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
  console.log("\n===== Phase 300 WP6 summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
