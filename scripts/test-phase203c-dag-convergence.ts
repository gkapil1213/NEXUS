// scripts/test-phase203c-dag-convergence.ts
// Phase 203 slice C: DAG convergence on larger and multi-level graphs.
// Sequential driver invocations; concurrent worker invocations for
// independent branches. No production changes.

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

function stageStatus(rawDb: Database.Database, stageId: string): string {
  return (rawDb.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(stageId) as any)?.status;
}

async function main() {
  console.log("=== NEXUS PHASE 203C ===\n");

  // S1 — 3-level chain A -> B -> C -> D
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_s1");
    for (const s of ["A", "B", "C", "D"]) seedStage(h.store, "ex_s1", s);
    h.store.stageDeps.add({ executionId: "ex_s1", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s1", stageName: "C", dependsOnStage: "B" });
    h.store.stageDeps.add({ executionId: "ex_s1", stageName: "D", dependsOnStage: "C" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s1", workerId: "worker-1",
    });

    ok("S1 converged", sum.converged === true);
    ok("S1 four stages dispatched in order",
       JSON.stringify(adapter.calls) === JSON.stringify(["A", "B", "C", "D"]),
       `calls=${adapter.calls.join(",")}`);
  }

  // S2 — deep chain A..J (10 stages)
  {
    const h = makeHarness();
    const names = ["A","B","C","D","E","F","G","H","I","J"];
    seedExecution(h.store, "ex_s2");
    for (const s of names) seedStage(h.store, "ex_s2", s);
    for (let i = 1; i < names.length; i++) {
      h.store.stageDeps.add({ executionId: "ex_s2", stageName: names[i], dependsOnStage: names[i-1] });
    }
    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s2", workerId: "worker-1",
    });
    ok("S2 deep chain converged", sum.converged === true);
    ok("S2 all ten in order",
       JSON.stringify(adapter.calls) === JSON.stringify(names),
       `calls=${adapter.calls.join(",")}`);
  }

  // S3 — wide fan-out: A -> (B, C, D, E, F)
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_s3");
    for (const s of ["A","B","C","D","E","F"]) seedStage(h.store, "ex_s3", s);
    for (const c of ["B","C","D","E","F"]) {
      h.store.stageDeps.add({ executionId: "ex_s3", stageName: c, dependsOnStage: "A" });
    }
    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s3", workerId: "worker-1",
    });
    ok("S3 fan-out converged", sum.converged === true);
    ok("S3 A dispatched before all children",
       adapter.calls[0] === "A",
       `first=${adapter.calls[0]}`);
    ok("S3 all children dispatched",
       ["B","C","D","E","F"].every((x) => adapter.calls.includes(x)),
       `calls=${adapter.calls.join(",")}`);
  }

  // S4 — two-level diamond A -> (B,C) -> D -> E
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_s4");
    for (const s of ["A","B","C","D","E"]) seedStage(h.store, "ex_s4", s);
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "C", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "D", dependsOnStage: "B" });
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "D", dependsOnStage: "C" });
    h.store.stageDeps.add({ executionId: "ex_s4", stageName: "E", dependsOnStage: "D" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s4", workerId: "worker-1",
    });
    ok("S4 two-level diamond converged", sum.converged === true);
    ok("S4 five stages dispatched",
       adapter.calls.length === 5, `count=${adapter.calls.length}`);
    ok("S4 E dispatched last",
       adapter.calls[adapter.calls.length - 1] === "E",
       `last=${adapter.calls[adapter.calls.length-1]}`);
  }

  // S5 — concurrent workers on diamond: worker-1 and worker-2 race
  //      to dispatch stages. Exactly one worker eventually dispatches each
  //      stage; D is not dispatched until both B and C are SUCCEEDED.
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_s5");
    for (const s of ["A","B","C","D"]) seedStage(h.store, "ex_s5", s);
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "C", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "D", dependsOnStage: "B" });
    h.store.stageDeps.add({ executionId: "ex_s5", stageName: "D", dependsOnStage: "C" });

    const adapter = makeAdapter();
    const [w1, w2] = await Promise.all([
      runStageGraphToCompletion({
        store: h.store, leaseManager: h.leases, adapter: adapter as any,
        executionId: "ex_s5", workerId: "worker-1",
      }),
      runStageGraphToCompletion({
        store: h.store, leaseManager: h.leases, adapter: adapter as any,
        executionId: "ex_s5", workerId: "worker-2",
      }),
    ]);

    // Union of dispatched must be exactly {A,B,C,D} with no duplicates.
    const union = new Set([...w1.dispatched, ...w2.dispatched]);
    ok("S5 concurrent: all four dispatched",
       union.size === 4 && ["A","B","C","D"].every((x) => union.has(x)),
       `union=${[...union].join(",")}`);
    ok("S5 concurrent: adapter calls exactly four (no duplicates)",
       adapter.calls.length === 4,
       `calls=${adapter.calls.join(",")}`);

    // Final durable state: all stages terminal SUCCEEDED.
    const adapterPort = new StageExecutionStoreAdapter(h.store);
    const stages = adapterPort.listForExecutionSync("ex_s5");
    ok("S5 all stages terminal SUCCEEDED",
       stages.every((s) => s.status === "SUCCEEDED"),
       `statuses=${stages.map((s) => s.status).join(",")}`);
  }

  // S6 — downstream never dispatched before both prerequisites complete.
  //      Force B to fail, C succeeds; D stays blocked.
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_s6");
    for (const s of ["A","B","C","D"]) seedStage(h.store, "ex_s6", s);
    h.store.stageDeps.add({ executionId: "ex_s6", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s6", stageName: "C", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s6", stageName: "D", dependsOnStage: "B" });
    h.store.stageDeps.add({ executionId: "ex_s6", stageName: "D", dependsOnStage: "C" });

    const calls: string[] = [];
    const adapter = {
      calls,
      getId: () => "test-adapter",
      healthCheck: async () => ({ healthy: true, ok: true }),
      execute: async (op: { operation: string }) => {
        calls.push(op.operation);
        if (op.operation === "B") return { success: false, stderr: "forced B failure" };
        return { success: true };
      },
    };

    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s6", workerId: "worker-1",
    });

    ok("S6 B failed", sum.failed.some((f) => f.stage === "B"));
    ok("S6 D not dispatched",
       !sum.dispatched.includes("D"),
       `dispatched=${sum.dispatched.join(",")}`);
    ok("S6 D blocked with terminal-failure reason",
       sum.blocked.some((b) => b.stage === "D" && b.reason === "DEPENDENCY_TERMINAL_FAILURE"),
       `blocked=${JSON.stringify(sum.blocked)}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });