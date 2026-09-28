// scripts/test-phase213-lifecycle-integrity.ts
// Phase 213 — Execution lifecycle finalization integrity.
//
// Drives the production finalizer against real PostgreSQL:
//   - finalizeExecutionAsync   (Phase 213 addition)
//   - recoverJobAtomicAsync    (existing)
//   - transitionExecutionAsync (existing)
//   - StageExecutionStoreAdapter.listForExecutionAsync (existing)
//   - ExecutionEngine.recoverStaleJobs (wired to async path in Phase 213)

import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import {
  computeExecutionOutcomeAsync,
  finalizeExecutionAsync,
} from "../src/core/execution-finalizer";

type Result = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
interface Row { id: string; name: string; result: Result; note: string; }
const rows: Row[] = [];
function record(id: string, name: string, result: Result, note: string): void {
  rows.push({ id, name, result, note });
  const mark = result === "PASS" ? "[PASS]" : result === "FAIL" ? "[FAIL]" : result === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${mark} ${id} ${name} -- ${note}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
function rid(p: string): string { return p + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

type Store = any;

async function pgExec(sql: string, params: unknown[] = []): Promise<any> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const c = new PgClient(); await c.connect(url);
  try { return await c.query(sql, params); } finally { await c.close(); }
}

async function pgCleanup(prefixes: string[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new PgClient(); await c.connect(url);
  try {
    for (const p of prefixes) {
      await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_artifacts WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_attempts WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_leases WHERE job_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_stage_dependencies WHERE execution_id LIKE $1", [p + "%"]);
      await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [p + "%"]);
    }
  } finally { await c.close(); }
}

// Create a parent pipeline job (RUNNING) + stage jobs in given statuses.
async function seedExecution(
  store: Store,
  executionId: string,
  stageStatuses: Record<string, string>,
): Promise<void> {
  const now = Date.now();
  await store.createJobAsync({
    id: executionId, idempotencyKey: "p213-" + executionId,
    jobType: "pipeline", payload: { executionId },
    status: "RUNNING", priority: -2000000000,
    createdAt: now, updatedAt: now,
    cancellationRequested: false, cancellationAcknowledged: false,
  } as any);
  for (const [stageName, status] of Object.entries(stageStatuses)) {
    const stageId = `${executionId}__${stageName}`;
    await store.createJobAsync({
      id: stageId, idempotencyKey: "p213-" + stageId,
      jobType: "pipeline.stage",
      payload: { kind: "pipeline.stage", executionId, stageName },
      status, priority: -2000000000,
      createdAt: now, updatedAt: now,
      cancellationRequested: false, cancellationAcknowledged: false,
    } as any);
  }
}

async function setCancellationRequested(store: Store, executionId: string): Promise<void> {
  const now = Date.now();
  await pgExec(
    "UPDATE execution_jobs SET cancellation_requested = 1, updated_at = $1 WHERE id = $2",
    [now, executionId],
  );
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "phase213-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    record("213A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as Store | undefined;
  if (!shared || !hasDb || !store) {
    const reason = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL not set" : "no executionStore";
    for (const [id, name] of [
      ["213A","normal execution finalization"],
      ["213B","duplicate finalization"],
      ["213C","concurrent finalization race"],
      ["213D","failed execution finalization"],
      ["213E","cancellation finalization"],
      ["213F","retry/finalization interaction"],
      ["213G","stale worker finalization rejection"],
      ["213H","scheduler restart recovery"],
      ["213I","process/recovery restart durability"],
      ["213J","terminal-state immutability"],
      ["213K","release state consistency"],
      ["213L","deployment state consistency"],
      ["213M","recovery must not resurrect terminal work"],
      ["213N","event/idempotency consistency"],
      ["213O","end-to-end execution lifecycle"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", reason);
    }
    return finish(kernel, prefix);
  }

  // 213A — normal execution finalization
  try {
    const execId = rid(prefix + "exec-A-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED", C: "SUCCEEDED" });
    const agg = await computeExecutionOutcomeAsync(store, execId);
    ok(agg.outcome === "SUCCEEDED", `outcome=${agg.outcome} reason=${agg.reason}`);
    const r = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r.ok && r.applied, `finalize not applied: ok=${r.ok} applied=${r.applied} reason=${r.reason}`);
    ok(r.status === "SUCCEEDED", `final status=${r.status}`);
    const post = await store.getJobAsync(execId);
    ok(post?.status === "SUCCEEDED", `durable status=${post?.status}`);
    record("213A", "normal execution finalization", "PASS", `SUCCEEDED via ALL_STAGES_SUCCEEDED`);
  } catch (e) { record("213A", "normal execution finalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213B — duplicate finalization
  try {
    const execId = rid(prefix + "exec-B-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const r1 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r1.ok && r1.applied, `first should apply: ${r1.reason}`);
    const r2 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r2.ok && !r2.applied, `second should be no-op: ok=${r2.ok} applied=${r2.applied}`);
    ok(r2.reason === "ALREADY_TERMINAL", `second reason=${r2.reason}`);
    const evts = await pgExec(
      "SELECT COUNT(*)::int AS c FROM execution_events WHERE job_id=$1 AND event_type='execution.lifecycle.finalized'",
      [execId]);
    ok(evts.rows[0].c === 1, `expected 1 finalized event, got ${evts.rows[0].c}`);
    record("213B", "duplicate finalization", "PASS", `second=${r2.reason} events=1`);
  } catch (e) { record("213B", "duplicate finalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213C — concurrent finalization race
  try {
    const execId = rid(prefix + "exec-C-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const [r1, r2, r3] = await Promise.all([
      finalizeExecutionAsync(store, execId, Date.now()),
      finalizeExecutionAsync(store, execId, Date.now()),
      finalizeExecutionAsync(store, execId, Date.now()),
    ]);
    const applied = [r1, r2, r3].filter((r) => r.applied).length;
    ok(applied === 1, `expected exactly 1 applied, got ${applied}`);
    const evts = await pgExec(
      "SELECT COUNT(*)::int AS c FROM execution_events WHERE job_id=$1 AND event_type='execution.lifecycle.finalized'",
      [execId]);
    ok(evts.rows[0].c === 1, `expected 1 event, got ${evts.rows[0].c}`);
    record("213C", "concurrent finalization race", "PASS", `applied=1 events=1`);
  } catch (e) { record("213C", "concurrent finalization race", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213D — failed execution finalization
  try {
    const execId = rid(prefix + "exec-D-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "FAILED", C: "SUCCEEDED" });
    const agg = await computeExecutionOutcomeAsync(store, execId);
    ok(agg.outcome === "FAILED", `outcome=${agg.outcome}`);
    const r = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r.ok && r.applied && r.status === "FAILED", `status=${r.status}`);
    record("213D", "failed execution finalization", "PASS", `FAILED via STAGE_TERMINAL_FAILURE`);
  } catch (e) { record("213D", "failed execution finalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213E — cancellation finalization
  try {
    const execId = rid(prefix + "exec-E-");
    await seedExecution(store, execId, { A: "RUNNING", B: "PENDING" });
    await setCancellationRequested(store, execId);
    const agg = await computeExecutionOutcomeAsync(store, execId);
    ok(agg.outcome === "CANCELLED", `outcome=${agg.outcome} reason=${agg.reason}`);
    const r = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r.ok && r.applied && r.status === "CANCELLED", `status=${r.status}`);
    record("213E", "cancellation finalization", "PASS", `CANCELLED via CANCELLATION_REQUESTED`);
  } catch (e) { record("213E", "cancellation finalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213F — retry/finalization interaction
  try {
    const execId = rid(prefix + "exec-F-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const stageB = `${execId}__B`;
    const now = Date.now();
    await pgExec(
      "UPDATE execution_jobs SET status='RETRY_SCHEDULED', next_attempt_at=$1, updated_at=$2 WHERE id=$3",
      [now - 1000, now, stageB],
    );
    const agg = await computeExecutionOutcomeAsync(store, execId);
    ok(agg.outcome === "RUNNING", `retry-pending should keep RUNNING, got ${agg.outcome} (${agg.reason})`);
    const r = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r.ok && !r.applied, `finalize should not apply: ok=${r.ok} applied=${r.applied}`);
    ok(r.reason.startsWith("STAGES_RETRY_PENDING"), `reason=${r.reason}`);
    const post = await store.getJobAsync(execId);
    ok(post?.status === "RUNNING", `parent status=${post?.status}`);
    record("213F", "retry/finalization interaction", "PASS", `parent stays RUNNING while stage retry-pending`);
  } catch (e) { record("213F", "retry/finalization interaction", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213G — stale worker finalization rejection
  try {
    const execId = rid(prefix + "exec-G-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const r = await store.transitionExecutionAsync({
      jobId: execId, actor: "worker",
      expectedStatus: "RUNNING", newStatus: "SUCCEEDED",
      workerId: "w-attacker", leaseId: "lease-nonexistent",
    });
    ok(r.ok === false, `stale worker transition should be rejected, got ok=${r.ok}`);
    ok(r.reason === "WORKER_OWNERSHIP_LOST", `reason=${r.reason}`);
    const post = await store.getJobAsync(execId);
    ok(post?.status === "RUNNING", `parent changed unexpectedly: ${post?.status}`);
    record("213G", "stale worker finalization rejection", "PASS", `rejected=${r.reason}`);
  } catch (e) { record("213G", "stale worker finalization rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213H — scheduler restart recovery
  try {
    const execId = rid(prefix + "exec-H-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const k2 = new NexusKernel();
    await k2.boot();
    try {
      const store2 = (k2 as any).executionStore as Store;
      const r = await finalizeExecutionAsync(store2, execId, Date.now());
      ok(r.ok && r.applied && r.status === "SUCCEEDED", `post-restart finalize: ok=${r.ok} applied=${r.applied} status=${r.status}`);
    } finally {
      await k2.shutdown({ finalRecoveryPass: false });
    }
    record("213H", "scheduler restart recovery", "PASS", `finalized via second kernel`);
  } catch (e) { record("213H", "scheduler restart recovery", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213I — process/recovery restart durability
  try {
    const execId = rid(prefix + "exec-I-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    const k3 = new NexusKernel();
    await k3.boot();
    try {
      const store3 = (k3 as any).executionStore as Store;
      const r = await finalizeExecutionAsync(store3, execId, Date.now());
      ok(r.ok && r.applied, `durable finalize after fresh process: ${r.reason}`);
      const reloaded = await store3.getJobAsync(execId);
      ok(reloaded?.status === "SUCCEEDED", `reloaded=${reloaded?.status}`);
    } finally {
      await k3.shutdown({ finalRecoveryPass: false });
    }
    record("213I", "process/recovery restart durability", "PASS", `SUCCEEDED durable across process`);
  } catch (e) { record("213I", "process/recovery restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213J — terminal-state immutability
  try {
    const execId = rid(prefix + "exec-J-");
    await seedExecution(store, execId, { A: "SUCCEEDED" });
    const r1 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r1.ok && r1.applied && r1.status === "SUCCEEDED", `setup: ${r1.reason}`);
    const r2 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r2.ok && !r2.applied, `second no-op: ok=${r2.ok} applied=${r2.applied}`);
    const r3 = await store.transitionExecutionAsync({
      jobId: execId, actor: "system",
      expectedStatus: "SUCCEEDED", newStatus: "RUNNING",
    });
    ok(r3.ok === false, `terminal escape should be rejected: ok=${r3.ok}`);
    ok(r3.reason === "TERMINAL_STATE" || r3.reason === "STATE_MISMATCH", `reason=${r3.reason}`);
    const post = await store.getJobAsync(execId);
    ok(post?.status === "SUCCEEDED", `terminal status changed: ${post?.status}`);
    record("213J", "terminal-state immutability", "PASS", `SUCCEEDED preserved; escape rejected=${r3.reason}`);
  } catch (e) { record("213J", "terminal-state immutability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213K — release state consistency
  try {
    const execId = rid(prefix + "exec-K-");
    await seedExecution(store, execId, { A: "SUCCEEDED" });
    const intentKey = "intent-213K-" + execId;
    const now = Date.now();
    try {
      await pgExec(
        "INSERT INTO release_deployment_intents (" +
        "  intent_key, release_id, execution_id, artifact_id, artifact_digest, commit_sha," +
        "  environment, image_repository, image_tag, image_id, image_digest," +
        "  container_name, container_port, status, created_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)",
        [intentKey, "rel-213K", execId, "art-213K", "sha256:" + "a".repeat(64),
         "d".repeat(40), "staging", "localhost:5000/nexus/app", "t-213K", null,
         "sha256:" + "a".repeat(64), "nexus-213K", 8080, "DEPLOYING", now],
      );
      const r = await finalizeExecutionAsync(store, execId, Date.now());
      ok(r.ok && r.applied && r.status === "SUCCEEDED", `execution finalize: ${r.reason}`);
      const intents = await pgExec(
        "SELECT status FROM release_deployment_intents WHERE intent_key=$1", [intentKey]);
      ok(intents.rows.length === 1, `intent row missing`);
      ok(intents.rows[0].status === "DEPLOYING", `intent status=${intents.rows[0].status}`);
      record("213K", "release state consistency", "PASS",
        `execution=SUCCEEDED, intent row intact status=${intents.rows[0].status}`);
    } finally {
      await pgExec("DELETE FROM release_deployment_intents WHERE intent_key=$1", [intentKey]);
    }
  } catch (e) { record("213K", "release state consistency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213L — deployment state consistency
  try {
    const execId = rid(prefix + "exec-L-");
    await seedExecution(store, execId, { A: "SUCCEEDED" });
    const intentKey = "intent-213L-" + execId;
    const now = Date.now();
    try {
      await pgExec(
        "INSERT INTO release_deployment_intents (" +
        "  intent_key, release_id, execution_id, artifact_id, artifact_digest, commit_sha," +
        "  environment, image_repository, image_tag, image_id, image_digest," +
        "  container_name, container_port, status, deployment_id, created_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)",
        [intentKey, "rel-213L", execId, "art-213L", "sha256:" + "a".repeat(64),
         "d".repeat(40), "staging", "localhost:5000/nexus/app", "t-213L", null,
         "sha256:" + "a".repeat(64), "nexus-213L", 8080, "DEPLOYING", "dep-213L", now],
      );
      const r = await finalizeExecutionAsync(store, execId, Date.now());
      ok(r.ok && r.applied, `finalize: ${r.reason}`);
      const rows = await pgExec(
        "SELECT deployment_id FROM release_deployment_intents WHERE intent_key=$1", [intentKey]);
      ok(rows.rows[0]?.deployment_id === "dep-213L", `deployment_id=${rows.rows[0]?.deployment_id}`);
      record("213L", "deployment state consistency", "PASS",
        `deployment_id=dep-213L preserved`);
    } finally {
      await pgExec("DELETE FROM release_deployment_intents WHERE intent_key=$1", [intentKey]);
    }
  } catch (e) { record("213L", "deployment state consistency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213M — recovery must not resurrect terminal work
  try {
    const execId = rid(prefix + "exec-M-");
    await seedExecution(store, execId, { A: "SUCCEEDED" });
    const r1 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r1.ok && r1.applied && r1.status === "SUCCEEDED", `first finalize: ${r1.reason}`);
    const engine = (kernel as any).executionEngine;
    ok(engine && typeof engine.recoverStaleJobs === "function", "recoverStaleJobs missing");
    await engine.recoverStaleJobs(Date.now());
    const post = await store.getJobAsync(execId);
    ok(post?.status === "SUCCEEDED", `recovery mutated terminal: ${post?.status}`);
    const r2 = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r2.ok && !r2.applied, `recovery-time finalize re-applied: ok=${r2.ok} applied=${r2.applied}`);
    record("213M", "recovery must not resurrect terminal work", "PASS",
      `SUCCEEDED preserved across recoverStaleJobs`);
  } catch (e) { record("213M", "recovery must not resurrect terminal work", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213N — event/idempotency consistency
  try {
    const execId = rid(prefix + "exec-N-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED" });
    for (let i = 0; i < 5; i++) {
      await finalizeExecutionAsync(store, execId, Date.now());
    }
    const evts = await pgExec(
      "SELECT COUNT(*)::int AS c FROM execution_events WHERE job_id=$1 AND event_type='execution.lifecycle.finalized'",
      [execId]);
    ok(evts.rows[0].c === 1, `expected 1 finalized event after 5 calls, got ${evts.rows[0].c}`);
    const txEvts = await pgExec(
      "SELECT COUNT(*)::int AS c FROM execution_events WHERE job_id=$1 AND event_type LIKE 'execution.transition.%'",
      [execId]);
    ok(txEvts.rows[0].c === 0, `unexpected transition events: ${txEvts.rows[0].c}`);
    record("213N", "event/idempotency consistency", "PASS",
      `5 finalize calls -> 1 lifecycle.finalized event`);
  } catch (e) { record("213N", "event/idempotency consistency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 213O — end-to-end execution lifecycle
  try {
    const execId = rid(prefix + "exec-O-");
    await seedExecution(store, execId, { A: "SUCCEEDED", B: "SUCCEEDED", C: "SUCCEEDED", D: "SUCCEEDED" });
    const agg = await computeExecutionOutcomeAsync(store, execId);
    ok(agg.outcome === "SUCCEEDED", `pre-finalize outcome=${agg.outcome}`);
    const r = await finalizeExecutionAsync(store, execId, Date.now());
    ok(r.ok && r.applied && r.status === "SUCCEEDED", `finalize=${r.reason}`);
    const check = await pgExec(
      "SELECT status FROM execution_jobs WHERE id=$1", [execId]);
    ok(check.rows[0]?.status === "SUCCEEDED", `durable=${check.rows[0]?.status}`);
    const k4 = new NexusKernel();
    await k4.boot();
    try {
      const store4 = (k4 as any).executionStore as Store;
      const j = await store4.getJobAsync(execId);
      ok(j?.status === "SUCCEEDED", `second-kernel status=${j?.status}`);
    } finally {
      await k4.shutdown({ finalRecoveryPass: false });
    }
    record("213O", "end-to-end execution lifecycle", "PASS",
      `RUNNING -> SUCCEEDED, durable across kernels`);
  } catch (e) { record("213O", "end-to-end execution lifecycle", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  try { await pgCleanup([prefix]); } catch (e) { console.log("213 cleanup warning:", e); }
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 213 summary =====");
  console.log(`PASS: ${counts.PASS}`);
  console.log(`FAIL: ${counts.FAIL}`);
  console.log(`BLOCKED: ${counts.BLOCKED}`);
  console.log(`NOT EXECUTED: ${counts["NOT EXECUTED"]}`);
  if (counts.FAIL > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
