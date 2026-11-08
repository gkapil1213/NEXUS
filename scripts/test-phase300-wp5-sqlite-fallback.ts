import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "path";

import { SQLiteEngine } from "../src/core/sqlite-engine";
import { MigrationRunner } from "../src/core/migration-runner";
import { ExecutionStore } from "../src/core/execution-store";
import { RemoteExecutionManager } from "../src/core/remote-execution-manager";
import type { RemoteExecutionAdapter } from "../src/core/remote-execution-adapter";
import type { ExecutionAdapterRequest, ExecutionAdapterResult } from "../src/core/execution-adapter";

type DispatchStatus =
  | "DISPATCH_INTENT"
  | "DISPATCHED"
  | "DELIVERED"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "UNKNOWN";

interface AdapterState {
  statusById: Map<string, string>;
  defaultStatus: string;
  throwOnStatus: boolean;
  statusCalls: string[];
}

function ok(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeAdapter(state: AdapterState): RemoteExecutionAdapter {
  return {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async dispatch(
      _request: ExecutionAdapterRequest,
      _workerId: string,
      _leaseId: string
    ): Promise<{ dispatchId: string }> {
      return { dispatchId: "provider-" + randomUUID() };
    },
    async cancel(_dispatchId: string): Promise<void> {},
    async getStatus(id: string): Promise<{ status: string }> {
      state.statusCalls.push(id);
      if (state.throwOnStatus) {
        throw new Error("sqlite_test_adapter_unreachable");
      }
      return { status: state.statusById.get(id) ?? state.defaultStatus };
    },
    async collectResult(id: string): Promise<ExecutionAdapterResult> {
      return { success: true, exitCode: 0, evidence: { id } };
    },
    async *streamLogs(): AsyncIterable<{ sequence: number; type: string; data: string }> {
      // No log events in this test adapter.
    },
  };
}

function seedDispatch(
  raw: Database.Database,
  store: ExecutionStore,
  options: {
    status: DispatchStatus;
    externalProviderId?: string;
  }
): string {
  const id = "sqlite-wp5-" + randomUUID();
  const jobId = "sqlite-job-" + randomUUID();
  const now = Date.now();

  raw.prepare(`
    INSERT INTO execution_jobs (
      id, idempotency_key, job_type, payload, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    "sqlite-job-idem-" + jobId,
    "remote.exec",
    "{}",
    "RUNNING",
    now,
    now
  );

  store.addRemoteDispatch({
    dispatchId: id,
    jobId,
    attemptId: "attempt-" + id,
    workerId: "worker-sqlite",
    leaseId: "lease-" + id,
    idempotencyKey: "idem-" + id,
    status: options.status,
    externalProviderId: options.externalProviderId,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

async function main(): Promise<void> {
  const raw = new Database(":memory:");
  const results: { name: string; status: "PASS" | "FAIL"; detail: string }[] = [];

  async function test(name: string, fn: () => Promise<string>): Promise<void> {
    try {
      const detail = await fn();
      results.push({ name, status: "PASS", detail });
      console.log(`[PASS] ${name} -- ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, status: "FAIL", detail });
      console.log(`[FAIL] ${name} -- ${detail}`);
    }
  }

  try {
    SQLiteEngine.fromDatabase(raw);

    new MigrationRunner(
      raw,
      join(process.cwd(), "src", "db", "migrations")
    ).run();

    const engine = SQLiteEngine.fromDatabase(raw);
    const store = new ExecutionStore(engine);

    console.log("backend=SQLite in-memory");
    console.log("hasAsyncBackend=" + store.hasAsyncBackend());

    await test("WP5-SQLITE-1 SQLite-only backend selected", async () => {
      ok(store.hasAsyncBackend() === false, "Expected SQLite-only store without async backend");
      return "hasAsyncBackend=false";
    });

    await test("WP5-SQLITE-2 nonterminal dispatch reconciles and persists", async () => {
      const id = seedDispatch(raw, store, { status: "DISPATCHED" });

      const state: AdapterState = {
        statusById: new Map([[id, "COMPLETED"]]),
        defaultStatus: "DISPATCHED",
        throwOnStatus: false,
        statusCalls: [],
      };

      const manager = new RemoteExecutionManager(makeAdapter(state), store);
      await manager.initializeAsync();

      const persisted = store.getRemoteDispatch(id);
      ok(state.statusCalls.includes(id), "Adapter was not queried with dispatch ID");
      ok(persisted?.status === "COMPLETED", "Expected persisted COMPLETED, got " + persisted?.status);

      return "DISPATCHED reconciled to COMPLETED and persisted in SQLite";
    });

    await test("WP5-SQLITE-3 BLOCKED remains terminal", async () => {
      const id = seedDispatch(raw, store, { status: "BLOCKED" });

      const state: AdapterState = {
        statusById: new Map([[id, "COMPLETED"]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
      };

      const manager = new RemoteExecutionManager(makeAdapter(state), store);
      await manager.initializeAsync();

      const persisted = store.getRemoteDispatch(id);
      ok(persisted?.status === "BLOCKED", "BLOCKED changed to " + persisted?.status);
      ok(!state.statusCalls.includes(id), "BLOCKED dispatch was queried by adapter");

      return "BLOCKED preserved; adapter was not queried";
    });

    await test("WP5-SQLITE-4 all terminal states remain unchanged", async () => {
      const terminalStatuses: DispatchStatus[] = [
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "BLOCKED",
      ];

      const ids = terminalStatuses.map((status) => ({
        status,
        id: seedDispatch(raw, store, { status }),
      }));

      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
      };

      const manager = new RemoteExecutionManager(makeAdapter(state), store);
      await manager.initializeAsync();

      for (const item of ids) {
        const persisted = store.getRemoteDispatch(item.id);
        ok(
          persisted?.status === item.status,
          `${item.status} changed to ${persisted?.status}`
        );
      }

      ok(state.statusCalls.length === 0, "Terminal dispatches triggered adapter queries");

      return "COMPLETED, FAILED, CANCELLED and BLOCKED preserved without provider calls";
    });

    await test("WP5-SQLITE-5 provider status failure persists UNKNOWN", async () => {
      const id = seedDispatch(raw, store, { status: "DISPATCHED" });

      const state: AdapterState = {
        statusById: new Map(),
        defaultStatus: "DISPATCHED",
        throwOnStatus: true,
        statusCalls: [],
      };

      const manager = new RemoteExecutionManager(makeAdapter(state), store);
      await manager.initializeAsync();

      const persisted = store.getRemoteDispatch(id);
      ok(state.statusCalls.includes(id), "Expected adapter status lookup");
      ok(persisted?.status === "UNKNOWN", "Expected UNKNOWN, got " + persisted?.status);

      return "adapter failure handled; UNKNOWN persisted in SQLite";
    });

    await test("WP5-SQLITE-6 repeated initialization is idempotent", async () => {
      const id = seedDispatch(raw, store, { status: "DISPATCHED" });

      const state: AdapterState = {
        statusById: new Map([[id, "COMPLETED"]]),
        defaultStatus: "COMPLETED",
        throwOnStatus: false,
        statusCalls: [],
      };

      const manager = new RemoteExecutionManager(makeAdapter(state), store);

      await manager.initializeAsync();
      const firstCallCount = state.statusCalls.length;
      const targetCallCount = state.statusCalls.filter((x) => x === id).length;

      await manager.initializeAsync();

      ok(targetCallCount === 1, "Expected exactly one lookup for this dispatch, got " + targetCallCount);
      ok(
        state.statusCalls.length === firstCallCount,
        "Repeated initialization caused additional adapter lookups"
      );

      return "second initializeAsync call performed no additional reconciliation";
    });

  } catch (error) {
    console.error(
      "[SETUP FAIL]",
      error instanceof Error ? error.stack : String(error)
    );
    process.exitCode = 1;
  } finally {
    raw.close();
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;

  console.log("\n===== Phase 300 WP5 SQLite fallback summary =====");
  console.log("PASS: " + passed);
  console.log("FAIL: " + failed);
  console.log("TOTAL: " + results.length);

  if (failed > 0 || results.length !== 6) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});

