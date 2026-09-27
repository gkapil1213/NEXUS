// scripts/test-phase203b-worker-failure.ts
// Phase 203 slice B: attempt durability + stall recovery integration.
// Proves that a RUNNING stage left behind by a dead worker is visible to
// the existing Phase 197/200 recovery primitives.

import Database from "better-sqlite3";
import { join } from "path";
import { SQLiteEngine } from "../src/core/sqlite-engine";
import { ExecutionStore } from "../src/core/execution-store";
import { MigrationRunner } from "../src/core/migration-runner";
import { LeaseManager } from "../src/core/lease-manager";
import { ExecutionEngine } from "../src/core/execution-engine";
import { runStageGraphToCompletion } from "../src/core/stage-dispatch-driver";
import { StageExecutionStoreAdapter } from "../src/core/stage-execution-store-adapter";

let pass = 0, fail = 0, blocked = 0;
function ok(n: string, c: boolean, d = "") {
  if (c) { pass++; console.log("[PASSED] " + n + (d ? "  " + d : "")); }
  else   { fail++; console.log("[FAILED] " + n + (d ? "  " + d : "")); }
}
function blk(n: string, w: string) { blocked++; console.log("[BLOCKED] " + n + "  " + w); }

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function makeHarness() {
  const rawDb = new Database(":memory:");
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const leases = new LeaseManager(store);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, { events: { emit: () => undefined } } as any);
  return { store, rawDb, leases, engine };
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

function seedStageJob(store: ExecutionStore, executionId: string, stageName: string) {
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

function attemptCountFor(rawDb: Database.Database, jobId: string): number {
  return (rawDb.prepare("SELECT COUNT(*) AS c FROM execution_attempts WHERE job_id = ?").get(jobId) as any).c;
}

function attemptFor(rawDb: Database.Database, jobId: string): any {
  return rawDb.prepare("SELECT id, status, worker_id, lease_id, heartbeat_at FROM execution_attempts WHERE job_id = ?").get(jobId);
}

async function main() {
  console.log("=== NEXUS PHASE 203B ===\n");

  // S1 — driver creates one attempt per dispatched stage; both terminal on completion.
  {
    const h = makeHarness();
    const execId = "ex_s1";
    seedExecution(h.store, execId);
    seedStageJob(h.store, execId, "A");
    seedStageJob(h.store, execId, "B");
    h.store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S1 converged", sum.converged === true);
    ok("S1 attempt row exists for A", attemptCountFor(h.rawDb, execId + "_A") === 1);
    ok("S1 attempt row exists for B", attemptCountFor(h.rawDb, execId + "_B") === 1);
    const attA = attemptFor(h.rawDb, execId + "_A");
    const attB = attemptFor(h.rawDb, execId + "_B");
    ok("S1 attempt A terminal SUCCEEDED", attA?.status === "SUCCEEDED", `status=${attA?.status}`);
    ok("S1 attempt B terminal SUCCEEDED", attB?.status === "SUCCEEDED", `status=${attB?.status}`);
    ok("S1 attempt heartbeat seeded", attA?.heartbeat_at !== null && attA?.heartbeat_at !== undefined,
       `heartbeat=${attA?.heartbeat_at}`);
  }

  // S2 — adapter-throw path: stage FAILED, attempt FAILED, no ACTIVE lease leak.
  {
    const h = makeHarness();
    const execId = "ex_s2";
    seedExecution(h.store, execId);
    seedStageJob(h.store, execId, "A");

    const adapter = makeAdapter({ A: false });
    await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    const att = attemptFor(h.rawDb, execId + "_A");
    ok("S2 attempt exists", !!att);
    ok("S2 attempt FAILED", att?.status === "FAILED", `status=${att?.status}`);
    const activeLease = h.store.getActiveLeaseForJob(execId + "_A");
    ok("S2 no ACTIVE lease remains", activeLease === undefined);
  }

  // S3 — crash simulation: RUNNING stage + stale heartbeat + ACTIVE lease + attempt
  // must be discoverable by recoverStalledAttemptsTick and fenced.
  {
    const h = makeHarness();
    const execId = "ex_s3";
    seedExecution(h.store, execId);
    const stageId = seedStageJob(h.store, execId, "A");

    // Simulate a crashed worker: transition stage to RUNNING, acquire lease,
    // create attempt with old heartbeat, then never complete.
    const now = Date.now();
    const oldNow = now - 60_000;
    const l = h.leases.acquireLease(stageId, "dead-worker", 60_000);
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'RUNNING', current_lease_id = ? WHERE id = ?").run(l.leaseId, stageId);
    h.store.createAttempt({
      id: "att_s3", jobId: stageId, attemptNumber: 1, status: "RUNNING",
      workerId: "dead-worker", leaseId: l.leaseId,
      startedAt: oldNow, completedAt: null, error: null, evidence: null, createdAt: oldNow,
    } as any);
    // Set heartbeat_at in the past so the tick sees it as stale.
    h.rawDb.prepare("UPDATE execution_attempts SET heartbeat_at = ? WHERE id = ?").run(oldNow, "att_s3");
    // Also set the ACTIVE lease expired to match the stale-worker scenario.
    h.rawDb.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(oldNow, l.leaseId);

    // Invoke the existing Phase 197 recovery tick.
    const tick = h.engine.recoverStalledAttemptsTick(now, 5_000, 5_000, 3_000);
    ok("S3 recovery tick scanned >= 1", tick.scanned >= 1, `scanned=${tick.scanned}`);
    ok("S3 recovery tick fenced >= 1", tick.fenced >= 1, `fenced=${tick.fenced}`);

    const attAfter = attemptFor(h.rawDb, stageId);
    ok("S3 attempt fenced (FAILED)", attAfter?.status === "FAILED", `status=${attAfter?.status}`);

    const stageAfter = h.rawDb.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(stageId) as any;
    ok("S3 stage moved off RUNNING",
       stageAfter?.status !== "RUNNING",
       `status=${stageAfter?.status}`);
  }

  // S4 — after S3 fencing, downstream B is blocked on admission.
  {
    const h = makeHarness();
    const execId = "ex_s4";
    seedExecution(h.store, execId);
    const stageA = seedStageJob(h.store, execId, "A");
    seedStageJob(h.store, execId, "B");
    h.store.stageDeps.add({ executionId: execId, stageName: "B", dependsOnStage: "A" });

    // Manually force A to FAILED (terminal) — simulates the aftermath of S3 fencing.
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'FAILED' WHERE id = ?").run(stageA);

    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: execId, workerId: "worker-1",
    });

    ok("S4 B not dispatched (A failed)", !sum.dispatched.includes("B"));
    ok("S4 B blocked with terminal-failure reason",
       sum.blocked.some((b) => b.stage === "B" && b.reason === "DEPENDENCY_TERMINAL_FAILURE"),
       `blocked=${JSON.stringify(sum.blocked)}`);
  }

  // S5 — re-run driver on terminal state: no new attempts created.
  {
    const h = makeHarness();
    const execId = "ex_s5";
    seedExecution(h.store, execId);
    seedStageJob(h.store, execId, "A");

    const a1 = makeAdapter();
    await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a1 as any,
      executionId: execId, workerId: "worker-1",
    });
    const attemptsAfterFirst = attemptCountFor(h.rawDb, execId + "_A");

    const a2 = makeAdapter();
    await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a2 as any,
      executionId: execId, workerId: "worker-1",
    });
    const attemptsAfterSecond = attemptCountFor(h.rawDb, execId + "_A");

    ok("S5 no adapter calls on second run", a2.calls.length === 0);
    ok("S5 no new attempts created on second run",
       attemptsAfterFirst === attemptsAfterSecond,
       `first=${attemptsAfterFirst} second=${attemptsAfterSecond}`);
  }

  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });