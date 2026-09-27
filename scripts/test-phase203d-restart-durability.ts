// scripts/test-phase203d-restart-durability.ts
// Phase 203 slice D: driver state survives a real process-style restart.
//
// SQLite-only. The driver is sync-only today (see docs/phase203 known
// limitations); a Postgres-backend restart test would require async driver
// plumbing not present in 203a-203c. This test uses a file-backed SQLite DB
// that is closed and reopened between phases.

import Database from "better-sqlite3";
import { join } from "path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
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

const MIG_DIR = join(process.cwd(), "src", "db", "migrations");

function openDb(dbFile: string) {
  const rawDb = new Database(dbFile);
  new MigrationRunner(rawDb, MIG_DIR).run();
  const syncEngine = SQLiteEngine.fromDatabase(rawDb);
  const store = new ExecutionStore(syncEngine as any);
  const leases = new LeaseManager(store);
  const engine = new ExecutionEngine(store, {} as any, {} as any, {} as any, { events: { emit: () => undefined } } as any);
  return { rawDb, store, leases, engine };
}

function freshDbFile(tag: string): string {
  const f = join(tmpdir(), `nexus-p203d-${tag}-${Date.now()}.sqlite`);
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(f + s); } catch {} }
  return f;
}

function cleanupDb(f: string) {
  for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(f + s); } catch {} }
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

async function main() {
  console.log("=== NEXUS PHASE 203D ===\n");

  // S1 — dispatch linear A->B->C, close DB, reopen, verify full graph state
  //      survived and second driver invocation is a no-op.
  {
    const dbFile = freshDbFile("s1");
    let h = openDb(dbFile);
    seedExecution(h.store, "ex_s1");
    for (const s of ["A","B","C"]) seedStage(h.store, "ex_s1", s);
    h.store.stageDeps.add({ executionId: "ex_s1", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s1", stageName: "C", dependsOnStage: "B" });

    const a1 = makeAdapter();
    const sum1 = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a1 as any,
      executionId: "ex_s1", workerId: "worker-1",
    });
    ok("S1 first run converged", sum1.converged === true);
    ok("S1 first run dispatched A,B,C", a1.calls.length === 3);

    // Close and reopen
    h.rawDb.close();
    h = openDb(dbFile);

    // Verify durable state
    const port = new StageExecutionStoreAdapter(h.store);
    const stages = port.listForExecutionSync("ex_s1");
    ok("S1 all 3 stage rows survived", stages.length === 3);
    ok("S1 all stages terminal SUCCEEDED",
       stages.every((s) => s.status === "SUCCEEDED"),
       `statuses=${stages.map((s) => s.status).join(",")}`);

    // Verify edges survived
    const edges = h.store.stageDeps.listGraph("ex_s1");
    ok("S1 dependency edges survived", edges.length === 2, `edges=${edges.length}`);

    // No ACTIVE leases remain
    const activeLeases = h.rawDb.prepare("SELECT COUNT(*) AS c FROM execution_leases WHERE status = 'ACTIVE'").get() as any;
    ok("S1 no ACTIVE leases after completion", Number(activeLeases?.c) === 0, `count=${activeLeases?.c}`);

    // Second driver invocation: must be a no-op
    const a2 = makeAdapter();
    const sum2 = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: a2 as any,
      executionId: "ex_s1", workerId: "worker-2",
    });
    ok("S1 second run: no adapter calls", a2.calls.length === 0, `calls=${a2.calls.join(",")}`);
    ok("S1 second run: reported converged", sum2.converged === true);
    ok("S1 second run: all stages skipped", sum2.skipped.length === 3, `skipped=${sum2.skipped.join(",")}`);

    h.rawDb.close();
    cleanupDb(dbFile);
  }

  // S2 — mid-flight restart: stage left RUNNING with an ACTIVE lease and a
  //      stale heartbeat, close DB, reopen, run recovery, then complete graph.
  {
    const dbFile = freshDbFile("s2");
    let h = openDb(dbFile);
    seedExecution(h.store, "ex_s2");
    seedStage(h.store, "ex_s2", "A");
    seedStage(h.store, "ex_s2", "B");
    h.store.stageDeps.add({ executionId: "ex_s2", stageName: "B", dependsOnStage: "A" });

    const stageAId = "ex_s2_A";
    const now = Date.now();
    const oldNow = now - 60_000;

    // Simulate a crashed worker mid-A: stage RUNNING, lease ACTIVE, attempt
    // with stale heartbeat.
    const l = h.leases.acquireLease(stageAId, "dead-worker", 60_000);
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'RUNNING', current_lease_id = ? WHERE id = ?").run(l.leaseId, stageAId);
    h.store.createAttempt({
      id: "att_s2_A", jobId: stageAId, attemptNumber: 1, status: "RUNNING",
      workerId: "dead-worker", leaseId: l.leaseId,
      startedAt: oldNow, createdAt: oldNow,
    } as any);
    h.rawDb.prepare("UPDATE execution_attempts SET heartbeat_at = ? WHERE id = ?").run(oldNow, "att_s2_A");
    h.rawDb.prepare("UPDATE execution_leases SET expires_at = ? WHERE lease_id = ?").run(oldNow, l.leaseId);

    // Close before any recovery.
    h.rawDb.close();

    // Reopen: fresh process would see stage RUNNING, attempt stale, lease expired.
    h = openDb(dbFile);
    const preRecovery = h.rawDb.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(stageAId) as any;
    ok("S2 pre-recovery: A is RUNNING", preRecovery?.status === "RUNNING", `status=${preRecovery?.status}`);

    // Invoke Phase 197 recovery tick.
    const tick = h.engine.recoverStalledAttemptsTick(now, 5_000, 5_000, 3_000);
    ok("S2 recovery scanned >= 1", tick.scanned >= 1, `scanned=${tick.scanned}`);
    ok("S2 recovery fenced >= 1", tick.fenced >= 1, `fenced=${tick.fenced}`);

    const postRecovery = h.rawDb.prepare("SELECT status FROM execution_jobs WHERE id = ?").get(stageAId) as any;
    ok("S2 post-recovery: A moved off RUNNING",
       postRecovery?.status !== "RUNNING",
       `status=${postRecovery?.status}`);

    // Now the graph is A=FAILED (or ORPHANED) ? B remains blocked.
    const adapter = makeAdapter();
    const sum = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter as any,
      executionId: "ex_s2", workerId: "worker-3",
    });
    ok("S2 after recovery: B not dispatched",
       !sum.dispatched.includes("B"),
       `dispatched=${sum.dispatched.join(",")}`);

    h.rawDb.close();
    cleanupDb(dbFile);
  }

  // S3 — restart after partial progress: seed A as SUCCEEDED and B/C as
  // PENDING (as if an earlier run completed A then stopped), close DB,
  // reopen, dispatch remaining, and prove A is never re-executed.
  {
    const dbFile = freshDbFile("s3");
    let h = openDb(dbFile);
    seedExecution(h.store, "ex_s3");
    const stageAId = seedStage(h.store, "ex_s3", "A");
    seedStage(h.store, "ex_s3", "B");
    seedStage(h.store, "ex_s3", "C");
    h.store.stageDeps.add({ executionId: "ex_s3", stageName: "B", dependsOnStage: "A" });
    h.store.stageDeps.add({ executionId: "ex_s3", stageName: "C", dependsOnStage: "B" });

    // Simulate prior completion of A: terminal SUCCEEDED, no active lease.
    h.rawDb.prepare("UPDATE execution_jobs SET status = 'SUCCEEDED' WHERE id = ?").run(stageAId);

    h.rawDb.close();
    h = openDb(dbFile);

    const port = new StageExecutionStoreAdapter(h.store);
    const stages = port.listForExecutionSync("ex_s3");
    const stA = stages.find((s) => s.stageName === "A");
    const stB = stages.find((s) => s.stageName === "B");
    const stC = stages.find((s) => s.stageName === "C");
    ok("S3 A survived SUCCEEDED", stA?.status === "SUCCEEDED", `status=${stA?.status}`);
    ok("S3 B still PENDING", stB?.status === "PENDING", `status=${stB?.status}`);
    ok("S3 C still PENDING", stC?.status === "PENDING", `status=${stC?.status}`);

    const adapter2 = makeAdapter();
    const sum2 = await runStageGraphToCompletion({
      store: h.store, leaseManager: h.leases, adapter: adapter2 as any,
      executionId: "ex_s3", workerId: "worker-2",
    });
    ok("S3 second run did not re-execute A",
       !adapter2.calls.includes("A"),
       `calls=${adapter2.calls.join(",")}`);
    ok("S3 second run dispatched B and C",
       adapter2.calls.includes("B") && adapter2.calls.includes("C"),
       `calls=${adapter2.calls.join(",")}`);
    ok("S3 second run converged", sum2.converged === true);

    h.rawDb.close();
    cleanupDb(dbFile);
  }
  console.log(`\nPASS: ${pass}\nFAIL: ${fail}\nBLOCKED: ${blocked}`);
  process.exitCode = (fail > 0 || blocked > 0) ? 1 : 0;
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exitCode = 2; });