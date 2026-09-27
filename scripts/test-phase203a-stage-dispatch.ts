// scripts/test-phase203a-stage-dispatch.ts
// Phase 203 slice A: topologically-ordered stage dispatch driver.
// Runs against SQLite (in-process). All assertions read durable state.

import Database from "better-sqlite3";
import { join } from "path";
import { randomUUID } from "crypto";
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
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeStore(): ExecutionStore {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  return new ExecutionStore(syncEngine as any);
}

// Recording adapter that captures every execute() call. Returns configurable
// outcomes by stage name.
function makeAdapter(outcomes: Record<string, boolean> = {}) {
  const calls: string[] = [];
  return {
    calls,
    getId: () => "test-adapter",
    healthCheck: async () => ({ healthy: true, ok: true }),
    execute: async (op: { operation: string }) => {
      calls.push(op.operation);
      const success = outcomes[op.operation] ?? true;
      return success ? { success: true } : { success: false, stderr: "forced failure" };
    },
  };
}

function seedExecution(store: ExecutionStore, executionId: string, cancelled = false) {
  const now = Date.now();
  store.createJob({
    id: executionId,
    idempotencyKey: "k_" + executionId,
    jobType: "pipeline",
    payload: { tenantId: "t1", correlationId: "c1" },
    status: "RUNNING",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: cancelled,
    cancellationAcknowledged: false,
  } as any);
}

function seedStageJob(
  store: ExecutionStore,
  executionId: string,
  stageName: string,
) {
  const now = Date.now();
  const stageId = `${executionId}_${stageName}`;
  store.createJob({
    id: stageId,
    idempotencyKey: `${executionId}:${stageName}:1`,
    jobType: "pipeline.stage",
    payload: {
      kind: "pipeline.stage",
      executionId,
      stageName,
      tenantId: "t1",
      correlationId: "c1",
      attempt: 1,
      status: "PENDING",
      executor: "test",
      inputFingerprint: "fp",
      artifactReferences: [],
    },
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    cancellationAcknowledged: false,
  } as any);
  return stageId;
}

async function main() {
  console.log("=== NEXUS PHASE 203A ===\n");

  // S1 — linear A -> B -> C, all succeed
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s1";
    seedExecution(store, execId);
    seedStageJob(store, execId, "A");
    seedStageJob(store, execId, "B");
    seedStageJob(store, execId, "C");
    store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    store.stageDeps.add({ executionId: execId, stageName: "C", dependsOnStage: "B" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S1 converged", sum.converged === true, `converged=${sum.converged}`);
    ok("S1 dispatched A, B, C in topological order",
       JSON.stringify(sum.dispatched) === JSON.stringify(["A", "B", "C"]),
       `dispatched=${sum.dispatched.join(",")}`);
    ok("S1 adapter called exactly once per stage",
       adapter.calls.length === 3, `calls=${adapter.calls.join(",")}`);
  }

  // S2 — diamond: A -> (B, C) -> D; B and C order independent
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s2";
    seedExecution(store, execId);
    for (const s of ["A", "B", "C", "D"]) seedStageJob(store, execId, s);
    store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    store.stageDeps.add({ executionId: execId, stageName: "C", dependsOnStage: "A" });
    store.stageDeps.add({ executionId: execId, stageName: "D", dependsOnStage: "B" });
    store.stageDeps.add({ executionId: execId, stageName: "D", dependsOnStage: "C" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S2 converged", sum.converged === true);
    ok("S2 dispatched all four",
       sum.dispatched.length === 4, `dispatched=${sum.dispatched.join(",")}`);
    ok("S2 D dispatched after B and C",
       sum.dispatched.indexOf("D") === sum.dispatched.length - 1,
       `order=${sum.dispatched.join(">")}`);
    ok("S2 each stage executed exactly once",
       adapter.calls.length === 4);
  }

  // S3 — topological order enforced when declared order is reversed
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s3";
    seedExecution(store, execId);
    // Seed in deliberately wrong order: C declared first, then B, then A.
    seedStageJob(store, execId, "C");
    seedStageJob(store, execId, "B");
    seedStageJob(store, execId, "A");
    // Dependency: A -> B -> C.
    store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    store.stageDeps.add({ executionId: execId, stageName: "C", dependsOnStage: "B" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S3 converged despite reversed declared order", sum.converged === true);
    ok("S3 adapter order is A, B, C",
       JSON.stringify(adapter.calls) === JSON.stringify(["A", "B", "C"]),
       `calls=${adapter.calls.join(",")}`);
  }

  // S4 — terminal failure blocks downstream
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s4";
    seedExecution(store, execId);
    seedStageJob(store, execId, "A");
    seedStageJob(store, execId, "B");
    seedStageJob(store, execId, "C");
    store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });
    store.stageDeps.add({ executionId: execId, stageName: "C", dependsOnStage: "B" });

    const adapter = makeAdapter({ A: false });
    const sum = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S4 A failed", sum.failed.some((f) => f.stage === "A"));
    ok("S4 B not dispatched", !sum.dispatched.includes("B"));
    ok("S4 C not dispatched", !sum.dispatched.includes("C"));
    ok("S4 B blocked on A's terminal failure",
       sum.blocked.some((b) => b.stage === "B" && b.reason === "DEPENDENCY_TERMINAL_FAILURE"),
       `blocked=${JSON.stringify(sum.blocked)}`);
  }

  // S5 — cancelled execution short-circuits
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s5";
    seedExecution(store, execId, true);
    seedStageJob(store, execId, "A");

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S5 cancelled", sum.cancelled === true);
    ok("S5 no stages dispatched", sum.dispatched.length === 0);
    ok("S5 adapter never called", adapter.calls.length === 0);
  }

  // S6 — idempotency: run twice; second run skips all terminal stages
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s6";
    seedExecution(store, execId);
    seedStageJob(store, execId, "A");
    seedStageJob(store, execId, "B");
    store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });

    const a1 = makeAdapter();
    await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: a1 as any,
      executionId: execId, workerId: "worker-1",
    });

    const a2 = makeAdapter();
    const sum2 = await runStageGraphToCompletion({
      store, leaseManager: leases, adapter: a2 as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S6 second run: no adapter calls", a2.calls.length === 0, `calls=${a2.calls.join(",")}`);
    ok("S6 second run: stages skipped", sum2.skipped.length >= 2);
  }

  // S7 — two workers race for the same single-stage execution. Only one
  // acquireLease wins; the adapter must be called exactly once.
  {
    const store = makeStore();
    const leases = new LeaseManager(store);
    const execId = "ex_s7";
    seedExecution(store, execId);
    seedStageJob(store, execId, "A");
    // No dependencies; A is immediately eligible.

    const adapter = makeAdapter();

    const [w1, w2] = await Promise.all([
      runStageGraphToCompletion({
        store, leaseManager: leases, adapter: adapter as any,
        executionId: execId, workerId: "worker-1",
      }),
      runStageGraphToCompletion({
        store, leaseManager: leases, adapter: adapter as any,
        executionId: execId, workerId: "worker-2",
      }),
    ]);

    ok("S7 concurrent race: adapter called exactly once",
       adapter.calls.length === 1,
       `calls=${adapter.calls.join(",")}`);
    ok("S7 concurrent race: exactly one worker dispatched A",
       (w1.dispatched.includes("A") ? 1 : 0) + (w2.dispatched.includes("A") ? 1 : 0) === 1,
       `w1=${w1.dispatched.join(",")} w2=${w2.dispatched.join(",")}`);

    // Durable state: stage is SUCCEEDED, no ACTIVE lease remains.
    const finalStages = new StageExecutionStoreAdapter(store).listForExecutionSync(execId);
    const stageA = finalStages.find((s: any) => s.stageName === "A");
    ok("S7 concurrent race: stage A ended SUCCEEDED",
       stageA?.status === "SUCCEEDED",
       `status=${stageA?.status}`);

    const activeLease = store.getActiveLeaseForJob(stageA?.stageExecutionId ?? "");
    ok("S7 concurrent race: no ACTIVE lease remains",
       activeLease === undefined,
       `holder=${activeLease?.workerId ?? "none"}`);
  }
  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });