// scripts/test-phase204-execution-lifecycle.ts
// Phase 204: durable execution lifecycle finalization.

import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { runStageGraphToCompletion } from "../src/core/stage-dispatch-driver";
import { finalizeExecution, computeExecutionOutcome } from "../src/core/execution-finalizer";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness(dbFile?: string) {
  const rawDb = dbFile ? new Database(dbFile) : new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const leases = new LeaseManager(store);
  return { store, rawDb, leases };
}

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
    id: executionId, idempotencyKey: "k_" + executionId, jobType: "pipeline",
    payload: { tenantId: "t1", correlationId: "c1" },
    status: "RUNNING", createdAt: now, updatedAt: now,
    cancellationRequested: cancelled, cancellationAcknowledged: false,
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

function pipelineStatus(store: ExecutionStore, executionId: string): string | undefined {
  return store.getJob(executionId)?.status;
}

async function main() {
  console.log("=== NEXUS PHASE 204 ===\n");

  // 204a — all stages succeed; pipeline moves RUNNING -> SUCCEEDED
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_a");
    seedStage(h.store, "ex_a", "A");
    seedStage(h.store, "ex_a", "B");
    h.store.stageDeps.add({ executionId: "ex_a", stageName: "B", dependsOnStage: "A" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_a", workerId: "worker-1",
    });
    ok("204a driver converged", sum.converged === true);
    ok("204a driver finalized", sum.finalized?.applied === true, `applied=${sum.finalized?.applied}`);
    ok("204a pipeline SUCCEEDED",
       pipelineStatus(h.store, "ex_a") === "SUCCEEDED",
       `status=${pipelineStatus(h.store, "ex_a")}`);
  }

  // 204b — terminal stage failure; pipeline moves RUNNING -> FAILED
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_b");
    seedStage(h.store, "ex_b", "A");
    seedStage(h.store, "ex_b", "B");
    h.store.stageDeps.add({ executionId: "ex_b", stageName: "B", dependsOnStage: "A" });

    const adapter = makeAdapter({ A: false });
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_b", workerId: "worker-1",
    });
    ok("204b driver finalized", sum.finalized?.applied === true);
    ok("204b pipeline FAILED",
       pipelineStatus(h.store, "ex_b") === "FAILED",
       `status=${pipelineStatus(h.store, "ex_b")}`);
  }

  // 204c — cancelled execution ? CANCELLED at finalization
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_c");
    seedStage(h.store, "ex_c", "A");

    // Cancel the parent before dispatch so all stages are considered
    // cancelled by the driver.
    h.rawDb.prepare("UPDATE execution_jobs SET cancellation_requested = 1 WHERE id = ?").run("ex_c");
    // Also cancel the only stage so the driver sees it terminal.
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'CANCELLED' WHERE id = ?").run("ex_c_A");

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_c", workerId: "worker-1",
    });
    ok("204c driver reported cancelled or converged",
       sum.cancelled === true || sum.converged === true,
       `cancelled=${sum.cancelled} converged=${sum.converged}`);
    ok("204c pipeline CANCELLED",
       pipelineStatus(h.store, "ex_c") === "CANCELLED",
       `status=${pipelineStatus(h.store, "ex_c")}`);
  }

  // 204d — idempotent finalization: second call to finalizeExecution is a no-op
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_d");
    seedStage(h.store, "ex_d", "A");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_d_A");

    const r1 = finalizeExecution(h.store, "ex_d");
    const r2 = finalizeExecution(h.store, "ex_d");
    ok("204d first finalize applied",
       r1.ok && r1.applied === true && r1.status === "SUCCEEDED");
    ok("204d second finalize no-op",
       r2.ok && r2.applied === false && r2.reason === "ALREADY_TERMINAL",
       `reason=${r2.reason}`);

    // Event exactly once
    const eventCount = (h.rawDb.prepare(
      "SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.lifecycle.finalized'"
    ).get("ex_d") as any).c;
    ok("204d exactly one lifecycle event", Number(eventCount) === 1, `count=${eventCount}`);
  }

  // 204e — concurrent finalizers: only one wins the CAS
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_e");
    seedStage(h.store, "ex_e", "A");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_e_A");

    const r1 = finalizeExecution(h.store, "ex_e");
    const r2 = finalizeExecution(h.store, "ex_e");
    const applied = [r1, r2].filter((r) => r.applied).length;
    ok("204e exactly one finalize applied", applied === 1, `applied=${applied}`);

    const eventCount = (h.rawDb.prepare(
      "SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.lifecycle.finalized'"
    ).get("ex_e") as any).c;
    ok("204e exactly one lifecycle event", Number(eventCount) === 1, `count=${eventCount}`);
  }

  // 204f — restart durability: finalize survives DB close/reopen
  {
    const dbFile = join(tmpdir(), `nexus-p204f-${Date.now()}.sqlite`);
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }

    let h = makeHarness(dbFile);
    seedExecution(h.store, "ex_f");
    seedStage(h.store, "ex_f", "A");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_f_A");
    const r1 = finalizeExecution(h.store, "ex_f");
    ok("204f first finalize applied", r1.applied === true);

    h.rawDb.close();
    h = makeHarness(dbFile);

    ok("204f pipeline SUCCEEDED after reopen",
       pipelineStatus(h.store, "ex_f") === "SUCCEEDED",
       `status=${pipelineStatus(h.store, "ex_f")}`);

    const r2 = finalizeExecution(h.store, "ex_f");
    ok("204f second finalize after reopen no-op",
       r2.applied === false && r2.reason === "ALREADY_TERMINAL",
       `reason=${r2.reason}`);

    h.rawDb.close();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }
  }

  // 204g — computeExecutionOutcome pure function across cases
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_g");
    seedStage(h.store, "ex_g", "A");
    seedStage(h.store, "ex_g", "B");

    // Both PENDING ? RUNNING
    let agg = computeExecutionOutcome(h.store, "ex_g");
    ok("204g both pending ? RUNNING", agg.outcome === "RUNNING", `outcome=${agg.outcome}`);

    // A SUCCEEDED, B PENDING ? RUNNING
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_g_A");
    agg = computeExecutionOutcome(h.store, "ex_g");
    ok("204g partial progress ? RUNNING", agg.outcome === "RUNNING", `outcome=${agg.outcome}`);

    // B FAILED ? FAILED
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'FAILED' WHERE id = ?").run("ex_g_B");
    agg = computeExecutionOutcome(h.store, "ex_g");
    ok("204g terminal failure ? FAILED", agg.outcome === "FAILED", `outcome=${agg.outcome}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });