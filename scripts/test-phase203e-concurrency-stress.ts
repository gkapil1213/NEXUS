// scripts/test-phase203e-concurrency-stress.ts
// Phase 203 slice E: concurrency and scale stress for the dispatch driver.
// SQLite in-process only (driver is sync-only today).

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { runStageGraphToCompletion } from "../src/core/stage-dispatch-driver";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness() {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const leases = new LeaseManager(store);
  return { store, rawDb, leases };
}

function makeAdapter() {
  const calls: string[] = [];
  return {
    calls,
    getId: () => "test-adapter",
    healthCheck: async () => ({ healthy: true, ok: true }),
    execute: async (op: { operation: string }) => {
      calls.push(op.operation);
      return { success: true };
    },
  };
}

function seedExecution(store: ExecutionStore, executionId: string) {
  const now = Date.now();
  store.createJob({
    id: executionId, idempotencyKey: "k_" + executionId, jobType: "pipeline",
    payload: { tenantId: "t1", correlationId: "c1" },
    status: "RUNNING", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
}

function seedStage(store: ExecutionStore, executionId: string, stageName: string) {
  const now = Date.now();
  const stageId = `${executionId}_${stageName}`;
  store.createJob({
    id: stageId, idempotencyKey: `${executionId}:${stageName}:1`,
    jobType: "pipeline.stage",
    payload: {
      kind: "pipeline.stage", executionId, stageName,
      tenantId: "t1", correlationId: "c1", attempt: 1,
      status: "PENDING", executor: "test",
      inputFingerprint: "fp", artifactReferences: [],
    },
    status: "QUEUED", createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
  return stageId;
}

function activeLeaseCount(rawDb: Database.Database): number {
  return Number((rawDb.prepare("SELECT COUNT(*) AS c FROM execution_leases WHERE status = 'ACTIVE'").get() as any)?.c ?? -1);
}

async function main() {
  console.log("=== NEXUS PHASE 203E ===\n");

  // S1 — wide fan-out: A -> 20 children. 5 concurrent drivers with distinct
  //      workerIds. Exactly 21 distinct adapter calls; every stage SUCCEEDED.
  {
    const h = makeHarness();
    const execId = "ex_s1";
    seedExecution(h.store, execId);
    seedStage(h.store, execId, "A");
    const children: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = "c" + i;
      children.push(c);
      seedStage(h.store, execId, c);
      h.store.stageDeps.add({ executionId: execId, stageName: c, dependsOnStage: "A" });
    }

    const adapter = makeAdapter();
    const drivers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        runStageGraphToCompletion({
          store: h.store, leaseManager: h.leases, adapter: adapter as any,
          executionId: execId, workerId: "worker-" + n,
        }),
      ),
    );

    const allDispatched = new Set<string>();
    for (const d of drivers) for (const s of d.dispatched) allDispatched.add(s);
    ok("S1 all 21 stages dispatched exactly once",
       allDispatched.size === 21,
       `unique=${allDispatched.size}`);
    ok("S1 adapter called exactly 21 times (no duplicates)",
       adapter.calls.length === 21,
       `calls=${adapter.calls.length}`);

    const port = new StageExecutionStoreAdapter(h.store);
    const stages = port.listForExecutionSync(execId);
    const allSucceeded = stages.every((s) => s.status === "SUCCEEDED");
    ok("S1 all stages terminal SUCCEEDED", allSucceeded,
       `statuses=${stages.map((s) => s.status).join(",")}`);
    ok("S1 no ACTIVE leases leaked", activeLeaseCount(h.rawDb) === 0,
       `count=${activeLeaseCount(h.rawDb)}`);
  }

  // S2 — 50-stage linear chain. One invocation. Timing bound 5s.
  {
    const h = makeHarness();
    const execId = "ex_s2";
    seedExecution(h.store, execId);
    const names: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = "s" + i.toString().padStart(2, "0");
      names.push(s);
      seedStage(h.store, execId, s);
    }
    for (let i = 1; i < names.length; i++) {
      h.store.stageDeps.add({ executionId: execId, stageName: names[i], dependsOnStage: names[i - 1] });
    }

    const adapter = makeAdapter();
    const t0 = Date.now();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });
    const dt = Date.now() - t0;

    ok("S2 50-stage chain converged", sum.converged === true);
    ok("S2 adapter called 50 times", adapter.calls.length === 50, `calls=${adapter.calls.length}`);
    ok("S2 dispatched in topological order",
       adapter.calls.join(",") === names.join(","),
       `first=${adapter.calls[0]} last=${adapter.calls[adapter.calls.length-1]}`);
    ok("S2 runtime under 5000ms", dt < 5000, `dt=${dt}ms`);
    ok("S2 no ACTIVE leases leaked", activeLeaseCount(h.rawDb) === 0, `count=${activeLeaseCount(h.rawDb)}`);
  }

  // S3 — idempotent re-dispatch on converged 50-stage chain.
  {
    const h = makeHarness();
    const execId = "ex_s3";
    seedExecution(h.store, execId);
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const s = "s" + i;
      names.push(s);
      seedStage(h.store, execId, s);
    }
    for (let i = 1; i < names.length; i++) {
      h.store.stageDeps.add({ executionId: execId, stageName: names[i], dependsOnStage: names[i - 1] });
    }

    const a1 = makeAdapter();
    await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a1 as any,
      executionId: execId, workerId: "worker-1",
    });
    const a2 = makeAdapter();
    const sum2 = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a2 as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S3 second run: no adapter calls", a2.calls.length === 0, `calls=${a2.calls.length}`);
    ok("S3 second run: converged", sum2.converged === true);
    ok("S3 second run: all skipped", sum2.skipped.length === 20, `skipped=${sum2.skipped.length}`);
    ok("S3 second run: no ACTIVE leases leak", activeLeaseCount(h.rawDb) === 0);
  }

  // S4 — repeated immediate dispatches on an already-terminal single-stage
  //      graph. Proves the driver is stateless between invocations.
  {
    const h = makeHarness();
    const execId = "ex_s4";
    seedExecution(h.store, execId);
    seedStage(h.store, execId, "only");

    const a1 = makeAdapter();
    await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a1 as any,
      executionId: execId, workerId: "worker-1",
    });

    let extra = 0;
    for (let i = 0; i < 5; i++) {
      const a = makeAdapter();
      const s = await runStageGraphToCompletion({
        store: h.store, leaseManager: h.leases, adapter: a as any,
        executionId: execId, workerId: "worker-" + (i + 2),
      });
      extra += a.calls.length;
      if (!s.converged) { fail++; console.log("[FAILED] S4 sub-run not converged"); }
    }
    ok("S4 no dispatch across 5 repeated runs", extra === 0, `extra=${extra}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });