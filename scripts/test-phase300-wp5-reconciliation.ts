// scripts/test-phase300-wp5-reconciliation.ts
// Phase 300 / WP5 - RemoteExecutionManager reconciliation test.
//
// Verifies the manager's initializeAsync retryability, coalescing, restart
// reconciliation, and terminal-state preservation against an isolated
// PostgreSQL database. Uses a configurable adapter stub so the reconcile
// loop's provider view can be controlled without touching PG.

import { randomUUID } from "node:crypto";
import { PgClient } from "../src/core/pg-client";
import { PgAsyncEngine } from "../src/core/pg-async-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import type { RemoteExecutionAdapter } from "../src/core/remote-execution-adapter";
import type { ExecutionAdapterRequest, ExecutionAdapterResult } from "../src/core/execution-adapter";

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

// A configurable adapter. Behavior:
//   statusById      - what getStatus() returns for a given dispatch or provider id
//   throwOnStatus   - if true, getStatus() throws (to test failure propagation)
//   calls           - list of ids getStatus() was called with
interface AdapterState {
  statusById: Map<string, { status: string }>;
  defaultStatus: string;
  throwOnStatus: boolean;
  statusCalls: string[];
  connectCalls: number;
  dispatchCalls: number;
}

function makeAdapterStub(state: AdapterState): RemoteExecutionAdapter {
  return {
    async connect(): Promise<void> { state.connectCalls++; },
    async disconnect(): Promise<void> {},
    async dispatch(_req: ExecutionAdapterRequest, _w: string, _l: string): Promise<{ dispatchId: string }> {
      state.dispatchCalls++;
      return { dispatchId: "provider-" + randomUUID() };
    },
    async getStatus(id: string): Promise<{ status: string }> {
      state.statusCalls.push(id);
      if (state.throwOnStatus) throw new Error("adapter_status_unreachable");
      const found = state.statusById.get(id);
      if (found) return found;
      return { status: state.defaultStatus };
    },
    async collectResult(id: string): Promise<ExecutionAdapterResult> {
      return { success: true, exitCode: 0, evidence: { id } };
    },
    async cancel(_id: string): Promise<void> {},
    streamLogs(_id: string): AsyncIterable<{ sequence: number; type: string; data: string }> {
      return {
        [Symbol.asyncIterator]() {
          return { next() { return Promise.reject(new Error("not_supported")); } };
        },
      };
    },
  } as any;
}

function makeStore(client: PgClient): ExecutionStore {
  const engine = new PgAsyncEngine(client);
  return new (ExecutionStore as any)({} as any, engine);
}

async function main(): Promise<void> {
  const mode = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase();
  const hasDb = !!process.env.DATABASE_URL;
  console.log("mode=" + mode + " databaseUrl=" + (hasDb ? "set" : "unset"));
  if (mode !== "shared" || !hasDb) {
    for (const id of ["WP5-1","WP5-2","WP5-3","WP5-4","WP5-5","WP5-6","WP5-7","WP5-8","WP5-9"]) {
      record(id, "requires shared mode + DATABASE_URL", "BLOCKED",
             "NEXUS_PERSISTENCE_MODE=shared and DATABASE_URL required");
    }
    return;
  }

  const admin = new PgClient();
  const dbName = "nexus_p300wp5_" + randomUUID().replace(/-/g, "").slice(0, 12);
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

    // --- WP5-1: first init on empty DB ---------------------------------
    await test("WP5-1", "first initializeAsync on empty DB succeeds", async () => {
      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "DISPATCHED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();
      ok(state.statusCalls.length === 0, "expected zero status calls on empty DB, got " + state.statusCalls.length);
      return "init ok, no status calls";
    });

    // --- WP5-2: concurrent initializeAsync coalesces -------------------
    await test("WP5-2", "concurrent initializeAsync calls coalesce", async () => {
      // Seed one dispatch so reconcile work exists.
      const d = "wp5-2-disp-" + randomUUID();
      const j = "wp5-2-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "DISPATCHED" });
      const state: AdapterState = {
        statusById: new Map([[d, { status: "COMPLETED" }]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await Promise.all([mgr.initializeAsync(), mgr.initializeAsync(), mgr.initializeAsync()]);
      // The single seeded non-terminal dispatch should be status-queried exactly once.
      const seen = state.statusCalls.filter((x) => x === d || x === "provider-" + d).length;
      ok(seen === 1, "expected exactly 1 status lookup, got " + seen);
      return "3 concurrent init calls, dispatch queried " + seen + " time(s)";
    });

    // --- WP5-3: provider status failure handling ----------------------
    await test("WP5-3", "provider status failure persists UNKNOWN without rejecting initialization", async () => {
      const d = "wp5-3-disp-" + randomUUID();
      const j = "wp5-3-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "DISPATCHED" });
      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "DISPATCHED",
        throwOnStatus: true,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();

      const r = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(state.statusCalls.includes(d), "adapter status lookup was not attempted");
      ok(r.rows[0]?.status === "UNKNOWN", "expected persisted UNKNOWN, got " + r.rows[0]?.status);
      return "adapter error caught; UNKNOWN persisted in PostgreSQL";
    });
    // --- WP5-4: retry after initializeAsync succeeds the second time ---
    await test("WP5-4", "initializeAsync is idempotent for repeat calls", async () => {
      const d = "wp5-4-disp-" + randomUUID();
      const j = "wp5-4-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "DISPATCHED" });
      const state: AdapterState = {
        statusById: new Map([[d, { status: "COMPLETED" }]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();
      const firstCalls = state.statusCalls.length;
      await mgr.initializeAsync();
      ok(state.statusCalls.length === firstCalls, "second init triggered extra adapter calls: " + (state.statusCalls.length - firstCalls));
      return "second initializeAsync is a no-op";
    });

    // --- WP5-5: restart reconciliation of non-terminal dispatch --------
    await test("WP5-5", "reconcile updates non-terminal dispatch through adapter", async () => {
      const d = "wp5-5-disp-" + randomUUID();
      const j = "wp5-5-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "DISPATCHED" });
      const state: AdapterState = {
        statusById: new Map([[d, { status: "COMPLETED" }]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();
      const r = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(r.rows[0]?.status === "COMPLETED", "expected COMPLETED, got " + r.rows[0]?.status);
      return "non-terminal dispatch updated to COMPLETED via adapter";
    });

    // --- WP5-6: terminal-state preservation ----------------------------
    await test("WP5-6", "COMPLETED FAILED and CANCELLED remain terminal", async () => {
      const cases = [
        { id: "completed", status: "COMPLETED" },
        { id: "failed", status: "FAILED" },
        { id: "cancelled", status: "CANCELLED" },
      ];

      for (const item of cases) {
        await seedDispatch(isolated!, {
          dispatchId: "wp5-6-" + item.id + "-" + randomUUID(),
          jobId: "wp5-6-job-" + item.id + "-" + randomUUID(),
          workerId: "worker-A",
          status: item.status,
        });
      }

      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "DISPATCHED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };

      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();

      for (const item of cases) {
        const result = await pgExec(
          isolated!,
          "SELECT dispatch_id, status FROM remote_dispatches WHERE dispatch_id LIKE $1",
          ["wp5-6-" + item.id + "-%"]
        );

        ok(result.rows.length === 1, "expected one " + item.status + " row");
        ok(result.rows[0]?.status === item.status,
          item.status + " must be preserved; got " + result.rows[0]?.status);
        ok(!state.statusCalls.includes(result.rows[0].dispatch_id),
          item.status + " must not be queried by adapter");
      }

      return "COMPLETED, FAILED and CANCELLED preserved without adapter queries";
    });
    // --- WP5-7: separate empty-database case --------------------------
    record("WP5-7", "separate empty-database initialization", "NOT EXECUTED",
      "WP5-1 already verifies initialization against a fresh empty isolated database; no duplicate database is created.");
    // --- WP5-8: BLOCKED terminal-state preservation ------------------
    await test("WP5-8", "BLOCKED dispatch remains terminal and is not re-queried", async () => {
      const d = "wp5-8-disp-" + randomUUID();
      const j = "wp5-8-job-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "BLOCKED" });
      const state: AdapterState = {
        statusById: new Map([[d, { status: "COMPLETED" }]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();

      const r = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(r.rows[0]?.status === "BLOCKED", "BLOCKED must be preserved; got " + r.rows[0]?.status);
      ok(!state.statusCalls.includes(d), "BLOCKED must not be queried; calls=" + JSON.stringify(state.statusCalls));
      return "BLOCKED preserved; adapter was not queried";
    });
    // --- WP5-9: provider-id fallback path -----------------------------
    await test("WP5-9", "reconcile uses externalProviderId when present", async () => {
      const d = "wp5-9-disp-" + randomUUID();
      const j = "wp5-9-job-" + randomUUID();
      const providerId = "provider-wp5-9-" + randomUUID();
      await seedDispatch(isolated!, { dispatchId: d, jobId: j, workerId: "worker-A", status: "DISPATCHED", externalProviderId: providerId });
      const state: AdapterState = {
        statusById: new Map([[providerId, { status: "COMPLETED" }]]),
        defaultStatus: "DISPATCHED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };
      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);
      await mgr.initializeAsync();
      // The adapter should be queried with the provider ID, not the dispatch ID.
      const queriedWithProvider = state.statusCalls.includes(providerId);
      ok(queriedWithProvider, "adapter was not queried with provider ID; calls=" + JSON.stringify(state.statusCalls.slice(-5)));
      const r = await pgExec(isolated!, "SELECT status FROM remote_dispatches WHERE dispatch_id = $1", [d]);
      ok(r.rows[0]?.status === "COMPLETED", "expected COMPLETED, got " + r.rows[0]?.status);
      return "provider-id queried, dispatch reconciled to COMPLETED";
    });


    // --- WP5-10: terminal state wins over stale provider response ------
    await test("WP5-10", "concurrent BLOCKED state is not overwritten by stale provider response", async () => {
      const d = "wp5-10-disp-" + randomUUID();
      const j = "wp5-10-job-" + randomUUID();

      await seedDispatch(isolated!, {
        dispatchId: d,
        jobId: j,
        workerId: "worker-A",
        status: "DISPATCHED",
      });

      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };

      const adapter = makeAdapterStub(state);

      let releaseProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });

      let signalProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });

      adapter.getStatus = async (id: string): Promise<{ status: string }> => {
        state.statusCalls.push(id);

        if (id === d) {
          signalProviderStarted();
          await providerGate;
          return { status: "COMPLETED" };
        }

        return { status: "COMPLETED" };
      };

      const store = makeStore(isolated!);
      const mgr = new RemoteExecutionManager(adapter, store);

      const initialization = mgr.initializeAsync();

      // Wait until reconciliation is paused inside the provider call
      // for this exact dispatch. No timer or sleep is used.
      await providerStarted;

      // Simulate another process committing a terminal state.
      await pgExec(
        isolated!,
        "UPDATE remote_dispatches SET status = $1, updated_at = $2 WHERE dispatch_id = $3",
        ["BLOCKED", Date.now(), d]
      );

      // Provider now returns its stale COMPLETED status.
      releaseProvider();
      await initialization;

      const result = await pgExec(
        isolated!,
        "SELECT status FROM remote_dispatches WHERE dispatch_id = $1",
        [d]
      );

      ok(state.statusCalls.includes(d), "target dispatch was not queried");
      ok(result.rows.length === 1, "target dispatch row was not found");
      ok(
        result.rows[0]?.status === "BLOCKED",
        "stale provider response overwrote BLOCKED; actual status: " + result.rows[0]?.status
      );

      return "concurrent BLOCKED update survived stale provider COMPLETED response";
    });

    // --- WP5-11: initialization retries after persistence read failure -
    await test("WP5-11", "initializeAsync retries after a transient persistence read failure", async () => {
      const d = "wp5-11-disp-" + randomUUID();
      const j = "wp5-11-job-" + randomUUID();

      await seedDispatch(isolated!, {
        dispatchId: d,
        jobId: j,
        workerId: "worker-A",
        status: "DISPATCHED",
      });

      const state: AdapterState = {
        statusById: new Map([[d, { status: "COMPLETED" }]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
        connectCalls: 0,
        dispatchCalls: 0,
      };

      const adapter = makeAdapterStub(state);
      const store = makeStore(isolated!);

      const originalList = store.listAllRemoteDispatchesAsync;
      let attempts = 0;

      (store as any).listAllRemoteDispatchesAsync = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("wp5_test_transient_persistence_read_failure");
        }
        return await originalList.call(store);
      };

      const mgr = new RemoteExecutionManager(adapter, store);

      try {
        let firstAttemptRejected = false;

        try {
          await mgr.initializeAsync();
        } catch (error) {
          firstAttemptRejected =
            error instanceof Error &&
            error.message === "wp5_test_transient_persistence_read_failure";
        }

        ok(firstAttemptRejected, "first initialization did not reject with injected failure");
        ok(attempts === 1, "expected one failed persistence read; got " + attempts);

        await mgr.initializeAsync();

        ok(attempts === 2, "retry did not perform a second persistence read");
        ok(state.statusCalls.includes(d), "retry did not reconcile the dispatch");

        const result = await pgExec(
          isolated!,
          "SELECT status FROM remote_dispatches WHERE dispatch_id = $1",
          [d]
        );

        ok(result.rows[0]?.status === "COMPLETED",
          "retry did not persist COMPLETED; got " + result.rows[0]?.status);

        return "first initialization rejected; second initialization recovered and persisted COMPLETED";
      } finally {
        (store as any).listAllRemoteDispatchesAsync = originalList;
      }
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
  console.log("\n===== Phase 300 WP5 summary =====");
  console.log("PASS: " + pass);
  console.log("FAIL: " + fail);
  console.log("BLOCKED: " + blk);
  console.log("NOT EXECUTED: " + ne);
  process.exit(fail > 0 ? 1 : (blk > 0 || ne > 0) ? 2 : 0);
}).catch((e) => { console.error("FATAL:", e); process.exit(1); });
