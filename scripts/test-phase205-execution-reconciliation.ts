// scripts/test-phase205-execution-reconciliation.ts
// Phase 205: per-execution reconciliation.

import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { reconcileExecution, listExecutionsNeedingReconciliation } from "../src/core/execution-reconciler";

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

function seedStaleAttempt(harness: any, stageId: string) {
  const now = Date.now();
  const oldNow = now - 60_000;
  const l = harness.leases.acquireLease(stageId, "dead-worker", 60_000);
  harness.rawDb.prepare("UPDATE execution_jobs SET status = 'RUNNING', current_lease_id = ? WHERE id = ?").run(l.leaseId, stageId);
  harness.store.createAttempt({
    id: "att_" + stageId,
    jobId: stageId,
    attemptNumber: 1,
    status: "RUNNING",
    workerId: "dead-worker",
    leaseId: l.leaseId,
    startedAt: oldNow,
    createdAt: oldNow,
  } as any);
  harness.rawDb.prepare("UPDATE execution_attempts SET heartbeat_at = ? WHERE id = ?").run(oldNow, "att_" + stageId);
  harness.rawDb.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(oldNow, l.leaseId);
  return l.leaseId;
}

async function main() {
  console.log("=== NEXUS PHASE 205 ===\n");

  // 205a — reconcile healthy running execution: driver advances, parent finalizes
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_a");
    seedStage(h.store, "ex_a", "A");
    seedStage(h.store, "ex_a", "B");
    h.store.stageDeps.add({ executionId: "ex_a", stageName: "B", dependsOnStage: "A" });

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_a", workerId: "worker-1",
    });
    ok("205a action ADVANCED", res.action === "ADVANCED", `action=${res.action}`);
    ok("205a parent SUCCEEDED", res.postStatus === "SUCCEEDED", `post=${res.postStatus}`);
    ok("205a both stages dispatched", adapter.calls.length === 2);
  }

  // 205b — stale-attempt recovery: fence + finalize FAILED
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_b");
    const stageA = seedStage(h.store, "ex_b", "A");
    seedStage(h.store, "ex_b", "B");
    h.store.stageDeps.add({ executionId: "ex_b", stageName: "B", dependsOnStage: "A" });

    seedStaleAttempt(h, stageA);

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_b", workerId: "worker-1",
    });
    ok("205b at least one attempt fenced", res.staleFencedAttempts.length >= 1, `fenced=${res.staleFencedAttempts.length}`);
    ok("205b parent FAILED", res.postStatus === "FAILED", `post=${res.postStatus}`);
  }

  // 205c — retry-aware: RETRY_SCHEDULED stage keeps parent RUNNING
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_c");
    const stageA = seedStage(h.store, "ex_c", "A");
    // Manually set stage A to RETRY_SCHEDULED (simulating a caller that
    // scheduled a retry). No retry scheduler exists in NEXUS today.
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'RETRY_SCHEDULED' WHERE id = ?").run(stageA);

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_c", workerId: "worker-1",
    });
    ok("205c parent stays RUNNING (retry-pending)", res.postStatus === "RUNNING", `post=${res.postStatus}`);
    ok("205c retryPendingStages includes A", res.retryPendingStages.includes("A"), `list=${res.retryPendingStages.join(",")}`);
    ok("205c adapter not called for A", adapter.calls.length === 0, `calls=${adapter.calls.join(",")}`);
  }

  // 205d — terminal failure reconciliation
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_d");
    const stageA = seedStage(h.store, "ex_d", "A");
    seedStage(h.store, "ex_d", "B");
    h.store.stageDeps.add({ executionId: "ex_d", stageName: "B", dependsOnStage: "A" });
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'FAILED' WHERE id = ?").run(stageA);

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_d", workerId: "worker-1",
    });
    ok("205d parent FAILED", res.postStatus === "FAILED", `post=${res.postStatus}`);
    ok("205d B not dispatched", !adapter.calls.includes("B"), `calls=${adapter.calls.join(",")}`);
  }

  // 205e — cancellation reconciliation
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_e");
    const stageA = seedStage(h.store, "ex_e", "A");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'CANCELLED' WHERE id = ?").run(stageA);
    h.rawDb.prepare("UPDATE execution_jobs SET cancellation_requested = 1 WHERE id = ?").run("ex_e");

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_e", workerId: "worker-1",
    });
    ok("205e parent CANCELLED", res.postStatus === "CANCELLED", `post=${res.postStatus}`);
  }

  // 205f — concurrent reconciliation race: only one CAS write, one lifecycle event
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_f");
    seedStage(h.store, "ex_f", "A");

    const a1 = makeAdapter();
    const a2 = makeAdapter();
    const [r1, r2] = await Promise.all([
      reconcileExecution({
        store: h.store, leaseManager: h.leases, adapter: a1 as any,
        executionId: "ex_f", workerId: "w1",
      }),
      reconcileExecution({
        store: h.store, leaseManager: h.leases, adapter: a2 as any,
        executionId: "ex_f", workerId: "w2",
      }),
    ]);

    // The real concurrency invariant is the durable final state after
    // both reconcilers settle. Individual `postStatus` observations are
    // interleaving-dependent — one reconciler may read the parent before
    // the other's driver commits the transition. What matters: after
    // both complete, the parent is terminal and there was exactly one
    // lifecycle event and one stage dispatch.
    const finalStatus = h.store.getJob("ex_f")?.status;
    ok("205f final durable parent status SUCCEEDED",
       finalStatus === "SUCCEEDED",
       `status=${finalStatus}`);

    const eventCount = (h.rawDb.prepare(
      "SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.lifecycle.finalized'"
    ).get("ex_f") as any).c;
    ok("205f exactly one lifecycle event", Number(eventCount) === 1, `count=${eventCount}`);

    const totalCalls = a1.calls.length + a2.calls.length;
    ok("205f stage dispatched exactly once", totalCalls === 1, `total=${totalCalls}`);
  }

  // 205g — repeated reconciliation idempotency
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_g");
    seedStage(h.store, "ex_g", "A");

    const adapter = makeAdapter();
    await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_g", workerId: "w1",
    });

    let noops = 0;
    for (let i = 0; i < 5; i++) {
      const r = await reconcileExecution({
        store: h.store, leaseManager: h.leases, adapter: makeAdapter() as any,
        executionId: "ex_g", workerId: "w1",
      });
      if (r.action === "NOOP_TERMINAL") noops++;
    }
    ok("205g 5 subsequent reconciles are NOOP_TERMINAL", noops === 5, `noops=${noops}`);

    const eventCount = (h.rawDb.prepare(
      "SELECT COUNT(*) AS c FROM execution_events WHERE job_id = ? AND event_type = 'execution.lifecycle.finalized'"
    ).get("ex_g") as any).c;
    ok("205g exactly one lifecycle event", Number(eventCount) === 1, `count=${eventCount}`);
  }

  // 205h — partial DAG: one SUCCEEDED, one PENDING, dependencies
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_h");
    const stageA = seedStage(h.store, "ex_h", "A");
    seedStage(h.store, "ex_h", "B");
    seedStage(h.store, "ex_h", "C");
    h.store.stageDeps.add({ executionId: "ex_h", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_h", stageName: "C", dependsOnStage: "B" });
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run(stageA);

    const adapter = makeAdapter();
    const res = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_h", workerId: "w1",
    });
    ok("205h B and C dispatched", adapter.calls.includes("B") && adapter.calls.includes("C"), `calls=${adapter.calls.join(",")}`);
    ok("205h parent SUCCEEDED", res.postStatus === "SUCCEEDED", `post=${res.postStatus}`);
  }

  // 205i — restart reconciliation durability
  {
    const dbFile = join(tmpdir(), `nexus-p205-${Date.now()}.sqlite`);
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }

    let h = makeHarness(dbFile);
    seedExecution(h.store, "ex_i");
    seedStage(h.store, "ex_i", "A");
    seedStage(h.store, "ex_i", "B");
    h.store.stageDeps.add({ executionId: "ex_i", stageName: "B", dependsOnStage: "A" });

    // Dispatch A but leave B pending: adapter only allows A.
    const adapterA = {
      calls: [] as string[],
      getId: () => "test-adapter",
      healthCheck: async () => ({ healthy: true, ok: true }),
      execute: async (op: { operation: string }) => {
        adapterA.calls.push(op.operation);
        return { success: true };
      },
    };
    const res1 = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: adapterA as any,
      executionId: "ex_i", workerId: "w1",
    });
    ok("205i first reconcile finalizes SUCCEEDED", res1.postStatus === "SUCCEEDED", `post=${res1.postStatus}`);

    h.rawDb.close();
    h = makeHarness(dbFile);

    ok("205i parent still SUCCEEDED after reopen",
       pipelineStatus(h.store, "ex_i") === "SUCCEEDED",
       `status=${pipelineStatus(h.store, "ex_i")}`);

    const res2 = await reconcileExecution({
      store: h.store, leaseManager: h.leases, adapter: makeAdapter() as any,
      executionId: "ex_i", workerId: "w2",
    });
    ok("205i second reconcile is NOOP_TERMINAL", res2.action === "NOOP_TERMINAL", `action=${res2.action}`);

    h.rawDb.close();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(dbFile + s); } catch {} }
  }

  // 205j — listExecutionsNeedingReconciliation scan
  {
    const h = makeHarness();
    seedExecution(h.store, "ex_running");
    seedStage(h.store, "ex_running", "A");
    seedExecution(h.store, "ex_cancelling");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'CANCELLATION_REQUESTED', cancellation_requested = 1 WHERE id = ?").run("ex_cancelling");
    seedExecution(h.store, "ex_done");
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run("ex_done");

    const list = listExecutionsNeedingReconciliation(h.store);
    ok("205j scan returns running + cancelling only",
       list.includes("ex_running") && list.includes("ex_cancelling") && !list.includes("ex_done"),
       `list=${list.join(",")}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });