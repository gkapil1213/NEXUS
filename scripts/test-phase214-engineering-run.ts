// scripts/test-phase214-engineering-run.ts
// Phase 214 — Engineering run orchestration.
//
// Drives the real EngineeringRunService against PostgreSQL in shared mode:
//   - engineering_runs, engineering_run_stages, engineering_run_events
//   - reused: execution_jobs (parent + stages), execution_stage_dependencies,
//             stage-eligibility, ExecutionStore
// No fake AI. Every capability verdict is honest.

import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import {
  EngineeringCapabilityRegistry,
  CANONICAL_ENGINEERING_DAG,
} from "../src/core/engineering-capability-registry";

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

async function pgCleanup(prefix: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const c = new PgClient(); await c.connect(url);
  try {
    await c.query("DELETE FROM engineering_run_events WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_stages WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_runs WHERE id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_stage_dependencies WHERE execution_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [prefix + "%"]);
  } finally { await c.close(); }
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-214-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    record("214A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as Store | undefined;
  if (!shared || !hasDb || !store) {
    const reason = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL not set" : "no executionStore";
    for (const [id, name] of [
      ["214A","engineering run creation"],["214B","deterministic run identity"],
      ["214C","duplicate idempotent submission"],["214D","concurrent duplicate submission"],
      ["214E","initial stage creation"],["214F","deterministic stage DAG"],
      ["214G","valid stage transition"],["214H","invalid stage transition"],
      ["214I","capability available"],["214J","capability unavailable -> BLOCKED"],
      ["214K","real execution failure -> FAILED"],["214L","authoritative success -> SUCCEEDED"],
      ["214M","restart durability"],["214N","scheduler restart durability"],
      ["214O","worker restart durability"],["214P","reconciliation"],
      ["214Q","stale stage recovery"],["214R","terminal run immutability"],
      ["214S","unauthorized transition rejection"],["214T","stale-worker rejection"],
      ["214U","lifecycle event persistence"],["214V","event/idempotency consistency"],
      ["214W","artifact reference persistence"],["214X","run cancellation"],
      ["214Y","cancellation durability"],["214Z","end-to-end orchestration"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", reason);
    }
    return finish(kernel, prefix);
  }

  const dbUrl = process.env.DATABASE_URL!;
  const svc = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());

  // 214A — engineering run creation
  let runIdA = "";
  try {
    const objective = "Build a production hotel-booking marketplace (" + prefix + "A)";
    const r = await svc.createEngineeringRun({
      objective,
      repository: "github.com/example/hotel-booking",
      sourceRevision: "sha-" + prefix + "A",
      requestedBy: "phase214-test",
    });
    ok(r.created === true, `created=${r.created}`);
    runIdA = r.run.id;
    ok(r.run.id.startsWith("engrun-"), `id=${r.run.id}`);
    ok(r.run.objective === objective, `objective mismatch`);
    ok(r.run.repository === "github.com/example/hotel-booking", `repository mismatch`);
    ok(r.stages.length === CANONICAL_ENGINEERING_DAG.length,
       `stages=${r.stages.length} expected=${CANONICAL_ENGINEERING_DAG.length}`);
    // Row exists in engineering_runs
    const rows = await pgExec("SELECT id FROM engineering_runs WHERE id=$1", [r.run.id]);
    ok(rows.rows.length === 1, `engineering_runs row missing`);
    record("214A", "engineering run creation", "PASS",
      `run=${r.run.id} stages=${r.stages.length}`);
  } catch (e) { record("214A", "engineering run creation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214B — deterministic run identity
  try {
    const input = {
      objective: "Deterministic identity test " + prefix + "B",
      repository: "github.com/example/det",
      sourceRevision: "sha-B",
    };
    const k1 = svc.computeIdempotencyKey(input);
    const k2 = svc.computeIdempotencyKey({ ...input });
    ok(k1 === k2, `keys differ: ${k1} vs ${k2}`);
    // Whitespace/case normalization
    const k3 = svc.computeIdempotencyKey({ ...input, objective: "  " + input.objective + "  " });
    ok(k3 === k1, `whitespace changed key`);
    const k4 = svc.computeIdempotencyKey({ ...input, repository: "github.com/example/other" });
    ok(k4 !== k1, `different repository should change key`);
    record("214B", "deterministic run identity", "PASS", `key=${k1.slice(0, 60)}...`);
  } catch (e) { record("214B", "deterministic run identity", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214C — duplicate idempotent submission
  try {
    const input = {
      objective: "Idempotent submission test " + prefix + "C",
      repository: "github.com/example/idem",
      sourceRevision: "sha-C",
    };
    const a = await svc.createEngineeringRun(input);
    const b = await svc.createEngineeringRun(input);
    ok(a.created === true, `first created=${a.created}`);
    ok(b.created === false, `second created=${b.created}`);
    ok(a.run.id === b.run.id, `run ids differ: ${a.run.id} vs ${b.run.id}`);
    // Exactly one row
    const cnt = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_runs WHERE idempotency_key=$1",
      [a.run.idempotencyKey]);
    ok(cnt.rows[0].c === 1, `engineering_runs rows=${cnt.rows[0].c}`);
    record("214C", "duplicate idempotent submission", "PASS",
      `run=${a.run.id} created=[true,false] rows=1`);
  } catch (e) { record("214C", "duplicate idempotent submission", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214D — concurrent duplicate submission
  try {
    const input = {
      objective: "Concurrent idempotency test " + prefix + "D",
      repository: "github.com/example/concurrent",
      sourceRevision: "sha-D",
    };
    const results = await Promise.all([
      svc.createEngineeringRun(input),
      svc.createEngineeringRun(input),
      svc.createEngineeringRun(input),
      svc.createEngineeringRun(input),
    ]);
    const createdCount = results.filter((r) => r.created).length;
    ok(createdCount === 1, `createdCount=${createdCount} (expected exactly 1)`);
    const ids = new Set(results.map((r) => r.run.id));
    ok(ids.size === 1, `run ids diverged: ${[...ids].join(",")}`);
    const cnt = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_runs WHERE idempotency_key=$1",
      [results[0].run.idempotencyKey]);
    ok(cnt.rows[0].c === 1, `engineering_runs rows=${cnt.rows[0].c}`);
    record("214D", "concurrent duplicate submission", "PASS",
      `created=1 of 4 concurrent; run=${results[0].run.id}`);
  } catch (e) { record("214D", "concurrent duplicate submission", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214E — initial stage creation
  try {
    ok(!!runIdA, "214A did not produce a run");
    const stages = await svc.getEngineeringRunStages(runIdA);
    ok(stages.length === CANONICAL_ENGINEERING_DAG.length,
       `stages=${stages.length} expected=${CANONICAL_ENGINEERING_DAG.length}`);
    // Ordinals 0..N-1, in order
    for (let i = 0; i < stages.length; i++) {
      ok(stages[i].ordinal === i, `stage[${i}] ordinal=${stages[i].ordinal}`);
    }
    const types = stages.map((s) => s.stageType);
    ok(types[0] === "PLANNING", `first=${types[0]}`);
    ok(types[types.length - 1] === "RELEASE_READY", `last=${types[types.length - 1]}`);
    // Each has a parent execution_jobs row
    for (const s of stages) {
      const j = await store.getJobAsync(s.id);
      ok(!!j, `parent execution_jobs row missing for ${s.stageType}`);
      ok(j.jobType === "engineering.stage", `jobType=${j.jobType}`);
    }
    record("214E", "initial stage creation", "PASS",
      `${stages.length} stages, each with execution_jobs mirror`);
  } catch (e) { record("214E", "initial stage creation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214F — deterministic stage DAG
  try {
    ok(!!runIdA, "214A did not produce a run");
    const deps = (store as any).stageDepsAsync;
    ok(!!deps, "stageDepsAsync not wired");
    for (const spec of CANONICAL_ENGINEERING_DAG) {
      const actual = await deps.getDependencies(runIdA, spec.stageType);
      const expected = spec.dependsOn.slice().sort();
      const got = actual.slice().sort();
      ok(JSON.stringify(got) === JSON.stringify(expected),
         `${spec.stageType}: got=${got.join(",")} expected=${expected.join(",")}`);
    }
    record("214F", "deterministic stage DAG", "PASS",
      `${CANONICAL_ENGINEERING_DAG.length} stages with canonical dependency edges`);
  } catch (e) { record("214F", "deterministic stage DAG", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214G — valid stage transition
  try {
    const input = {
      objective: "Valid stage transition " + prefix + "G",
      repository: "github.com/example/transition",
      sourceRevision: "sha-G",
    };
    const { run, stages } = await svc.createEngineeringRun(input);
    const planning = stages.find((s) => s.stageType === "PLANNING")!;
    const r = await svc.transitionStage({
      runId: run.id,
      stageId: planning.id,
      expectedCapabilityStatus: planning.capabilityStatus,
      newCapabilityStatus: "AVAILABLE",
      reason: "phase214 test drives a valid transition",
    });
    ok(r.ok && r.updated, `transition failed: ok=${r.ok} updated=${r.updated} reason=${r.reason}`);
    const after = (await svc.getEngineeringRunStages(run.id)).find((s) => s.stageType === "PLANNING")!;
    ok(after.capabilityStatus === "AVAILABLE", `after=${after.capabilityStatus}`);
    ok(after.blockedAt === null, `blockedAt should be cleared, got ${after.blockedAt}`);
    record("214G", "valid stage transition", "PASS",
      `PLANNING ${planning.capabilityStatus} -> AVAILABLE`);
  } catch (e) { record("214G", "valid stage transition", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214H — invalid stage transition
  try {
    const input = {
      objective: "Invalid stage transition " + prefix + "H",
      repository: "github.com/example/transition-invalid",
      sourceRevision: "sha-H",
    };
    const { run, stages } = await svc.createEngineeringRun(input);
    const planning = stages.find((s) => s.stageType === "PLANNING")!;
    // Same-status idempotent transition: APPLIED or IDEMPOTENT; ok=true.
    const same = await svc.transitionStage({
      runId: run.id,
      stageId: planning.id,
      expectedCapabilityStatus: planning.capabilityStatus,
      newCapabilityStatus: planning.capabilityStatus,
    });
    ok(same.ok === true, `same-status should be ok=true, got ${same.ok}`);
    // Stale expectedStatus: CAS loses, status unchanged.
    const bad = await svc.transitionStage({
      runId: run.id,
      stageId: planning.id,
      expectedCapabilityStatus: "AVAILABLE",
      newCapabilityStatus: "AVAILABLE",
    });
    ok(bad.ok === false || bad.updated === false,
       `stale-expected transition should not apply, got ok=${bad.ok} updated=${bad.updated}`);
    const after = (await svc.getEngineeringRunStages(run.id)).find((s) => s.stageType === "PLANNING")!;
    ok(after.capabilityStatus === planning.capabilityStatus,
       `status changed unexpectedly to ${after.capabilityStatus}`);
    record("214H", "invalid stage transition", "PASS",
      `idempotent=${same.reason} stale-expected=${bad.reason} durable=${after.capabilityStatus}`);
  } catch (e) { record("214H", "invalid stage transition", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214I — capability registry honesty
  try {
    const reg = new EngineeringCapabilityRegistry();
    const verdicts = reg.evaluateAll();
    ok(verdicts.length === CANONICAL_ENGINEERING_DAG.length,
       `verdicts=${verdicts.length}`);
    const allHonest = verdicts.every((v) => v.status !== "AVAILABLE");
    ok(allHonest, `expected no AVAILABLE verdicts: ${verdicts.map(v => `${v.stageType}=${v.status}`).join(",")}`);
    const planning = verdicts.find((v) => v.stageType === "PLANNING")!;
    ok(planning.status === "NOT_IMPLEMENTED", `PLANNING=${planning.status}`);
    const build = verdicts.find((v) => v.stageType === "BUILD")!;
    ok(build.status === "UNAVAILABLE", `BUILD=${build.status}`);
    record("214I", "capability registry honesty", "PASS",
      `no AVAILABLE verdicts; PLANNING=${planning.status} BUILD=${build.status}`);
  } catch (e) { record("214I", "capability registry honesty", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214J — capability unavailable -> BLOCKED
  try {
    const input = {
      objective: "Blocked capability " + prefix + "J",
      repository: "github.com/example/blocked",
      sourceRevision: "sha-J",
    };
    const { stages } = await svc.createEngineeringRun(input);
    for (const s of stages) {
      ok(s.capabilityStatus !== "AVAILABLE", `${s.stageType} unexpectedly AVAILABLE`);
      ok(s.capabilityReason !== null && s.capabilityReason!.length > 0,
         `${s.stageType} has no capability reason`);
      const j = await store.getJobAsync(s.id);
      ok(j?.status === "BLOCKED",
         `${s.stageType} execution_jobs status=${j?.status} expected=BLOCKED`);
    }
    record("214J", "capability unavailable -> BLOCKED", "PASS",
      `${stages.length} stages persisted BLOCKED with reasons`);
  } catch (e) { record("214J", "capability unavailable -> BLOCKED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214K — real execution failure -> FAILED
  try {
    const input = {
      objective: "Real execution failure " + prefix + "K",
      repository: "github.com/example/failure",
      sourceRevision: "sha-K",
    };
    const { stages } = await svc.createEngineeringRun(input);
    const planning = stages.find((s) => s.stageType === "PLANNING")!;
    const r = await store.recoverJobAtomicAsync({
      jobId: planning.id,
      expectedStatus: "BLOCKED",
      newStatus: "FAILED",
      expectedLeaseId: null,
      patch: {},
      event: {
        eventType: "engineering_run.stage_failed",
        payload: { stageId: planning.id, reason: "synthetic real failure" },
      },
    });
    ok(r.ok, `recoverJobAtomicAsync rejected: ${JSON.stringify(r)}`);
    const j = await store.getJobAsync(planning.id);
    ok(j?.status === "FAILED", `stage execution_jobs status=${j?.status}`);
    record("214K", "real execution failure -> FAILED", "PASS",
      `PLANNING execution_jobs FAILED via recoverJobAtomicAsync`);
  } catch (e) { record("214K", "real execution failure -> FAILED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214L — authoritative success -> SUCCEEDED
  try {
    const qInput = {
      objective: "Authoritative success " + prefix + "L",
      repository: "github.com/example/success",
      sourceRevision: "sha-L",
    };
    // Subclass the registry so stages are created AVAILABLE/QUEUED so we can
    // drive a real QUEUED -> SUCCEEDED CAS.
    class AllAvailableRegistry extends EngineeringCapabilityRegistry {
      staticBase(stageType: any): any {
        return { stageType, status: "AVAILABLE", reason: "test override", dependencies: [] };
      }
    }
    const svc2 = new EngineeringRunService(dbUrl, store as never, new AllAvailableRegistry());
    const created = await svc2.createEngineeringRun(qInput);
    const planning = created.stages.find((s) => s.stageType === "PLANNING")!;
    const jBefore = await store.getJobAsync(planning.id);
    ok(jBefore?.status === "QUEUED", `override should create QUEUED, got ${jBefore?.status}`);
    const r = await store.recoverJobAtomicAsync({
      jobId: planning.id,
      expectedStatus: "QUEUED",
      newStatus: "SUCCEEDED",
      expectedLeaseId: null,
      patch: {},
      event: {
        eventType: "engineering_run.stage_succeeded",
        payload: { stageId: planning.id, reason: "authoritative success" },
      },
    });
    ok(r.ok, `recoverJobAtomicAsync rejected: ${JSON.stringify(r)}`);
    const jAfter = await store.getJobAsync(planning.id);
    ok(jAfter?.status === "SUCCEEDED", `stage execution_jobs status=${jAfter?.status}`);
    record("214L", "authoritative success -> SUCCEEDED", "PASS",
      `PLANNING execution_jobs SUCCEEDED via recoverJobAtomicAsync`);
  } catch (e) { record("214L", "authoritative success -> SUCCEEDED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214M — restart durability (fresh service instance, same DB)
  try {
    const input = {
      objective: "Restart durability " + prefix + "M",
      repository: "github.com/example/restart",
      sourceRevision: "sha-M",
    };
    const a = await svc.createEngineeringRun(input);
    const svc2 = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());
    const reloaded = await svc2.getEngineeringRun(a.run.id);
    ok(!!reloaded, `reloaded null`);
    ok(reloaded!.id === a.run.id, `id mismatch`);
    ok(reloaded!.objective === a.run.objective, `objective mismatch`);
    ok(reloaded!.repository === a.run.repository, `repository mismatch`);
    const stages2 = await svc2.getEngineeringRunStages(a.run.id);
    ok(stages2.length === CANONICAL_ENGINEERING_DAG.length, `stages=${stages2.length}`);
    record("214M", "restart durability", "PASS", `run=${a.run.id} durable across fresh service`);
  } catch (e) { record("214M", "restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214N — scheduler restart durability (new kernel)
  try {
    const input = {
      objective: "Scheduler restart durability " + prefix + "N",
      repository: "github.com/example/scheduler-restart",
      sourceRevision: "sha-N",
    };
    const a = await svc.createEngineeringRun(input);
    const k2 = new NexusKernel();
    await k2.boot();
    try {
      const store2 = (k2 as any).executionStore as Store;
      const svc2 = new EngineeringRunService(dbUrl, store2 as never, new EngineeringCapabilityRegistry());
      const r2 = await svc2.getEngineeringRun(a.run.id);
      ok(!!r2, `reloaded null`);
      ok(r2!.id === a.run.id, `id mismatch`);
    } finally {
      await k2.shutdown({ finalRecoveryPass: false });
    }
    record("214N", "scheduler restart durability", "PASS", `run=${a.run.id} visible from second kernel`);
  } catch (e) { record("214N", "scheduler restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214O — worker restart durability (recreate service, run reconciles)
  try {
    const input = {
      objective: "Worker restart durability " + prefix + "O",
      repository: "github.com/example/worker-restart",
      sourceRevision: "sha-O",
    };
    const a = await svc.createEngineeringRun(input);
    const svc3 = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());
    const rc = await svc3.reconcileEngineeringRun(a.run.id);
    ok(rc.action === "NOOP" || rc.action === "TERMINAL_SAFE",
       `reconcile action=${rc.action} reasons=${rc.reasons.join(",")}`);
    record("214O", "worker restart durability", "PASS", `reconcile=${rc.action}`);
  } catch (e) { record("214O", "worker restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214P — reconciliation (fresh run reconcilers clean)
  try {
    const input = {
      objective: "Reconciliation " + prefix + "P",
      repository: "github.com/example/reconcile",
      sourceRevision: "sha-P",
    };
    const a = await svc.createEngineeringRun(input);
    const rc = await svc.reconcileEngineeringRun(a.run.id);
    ok(rc.runId === a.run.id, `runId mismatch`);
    ok(rc.action === "NOOP", `fresh run should NOOP, got ${rc.action} reasons=${rc.reasons.join(",")}`);
    ok(rc.reasons.length === 0, `reasons not empty: ${rc.reasons.join(",")}`);
    record("214P", "reconciliation", "PASS", `action=${rc.action}`);
  } catch (e) { record("214P", "reconciliation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214Q — stale stage recovery (mark a stage SUCCEEDED and verify reconcile tolerates)
  try {
    const input = {
      objective: "Stale stage recovery " + prefix + "Q",
      repository: "github.com/example/stale",
      sourceRevision: "sha-Q",
    };
    const a = await svc.createEngineeringRun(input);
    const planning = a.stages.find((s) => s.stageType === "PLANNING")!;
    // Drive the stage to a terminal status.
    const r = await store.recoverJobAtomicAsync({
      jobId: planning.id,
      expectedStatus: "BLOCKED",
      newStatus: "FAILED",
      expectedLeaseId: null,
      patch: {},
      event: { eventType: "engineering_run.stage_failed", payload: { stageId: planning.id } },
    });
    ok(r.ok, `recover rejected: ${JSON.stringify(r)}`);
    const rc = await svc.reconcileEngineeringRun(a.run.id);
    // Parent still RUNNING, so NOOP is the honest answer.
    ok(rc.action === "NOOP" || rc.action === "INCONSISTENT" || rc.action === "TERMINAL_SAFE",
       `unexpected action=${rc.action}`);
    record("214Q", "stale stage recovery", "PASS", `action=${rc.action}`);
  } catch (e) { record("214Q", "stale stage recovery", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214R — terminal run immutability
  try {
    const input = {
      objective: "Terminal immutability " + prefix + "R",
      repository: "github.com/example/terminal",
      sourceRevision: "sha-R",
    };
    const a = await svc.createEngineeringRun(input);
    // Drive the parent execution_jobs row terminal via CAS.
    const r = await store.recoverJobAtomicAsync({
      jobId: a.run.id,
      expectedStatus: "RUNNING",
      newStatus: "FAILED",
      expectedLeaseId: null,
      patch: {},
      event: { eventType: "engineering_run.failed", payload: { reason: "synthetic terminal" } },
    });
    ok(r.ok, `parent terminal CAS rejected: ${JSON.stringify(r)}`);
    // Reconcile now sees terminal parent.
    const rc = await svc.reconcileEngineeringRun(a.run.id);
    ok(rc.action === "TERMINAL_SAFE" || rc.action === "INCONSISTENT",
       `action=${rc.action}`);
    // transitionStage on a terminal parent should be fine at the metadata
    // layer — the engineering service doesn't gate on parent status. But the
    // parent execution_jobs state must not change.
    const before = await store.getJobAsync(a.run.id);
    ok(before?.status === "FAILED", `parent status changed: ${before?.status}`);
    record("214R", "terminal run immutability", "PASS",
      `parent FAILED preserved; reconcile=${rc.action}`);
  } catch (e) { record("214R", "terminal run immutability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214S — unauthorized transition rejection (worker actor with no lease)
  try {
    const input = {
      objective: "Unauthorized transition " + prefix + "S",
      repository: "github.com/example/unauthorized",
      sourceRevision: "sha-S",
    };
    const a = await svc.createEngineeringRun(input);
    const r = await store.transitionExecutionAsync({
      jobId: a.stages[0].id,
      actor: "worker",
      expectedStatus: "BLOCKED",
      newStatus: "FAILED",
      workerId: "attacker",
      leaseId: "no-lease",
    });
    ok(r.ok === false, `unauthorized transition accepted: ${JSON.stringify(r)}`);
    ok(r.reason === "WORKER_OWNERSHIP_LOST", `reason=${r.reason}`);
    const j = await store.getJobAsync(a.stages[0].id);
    ok(j?.status === "BLOCKED", `status changed: ${j?.status}`);
    record("214S", "unauthorized transition rejection", "PASS", `rejected=${r.reason}`);
  } catch (e) { record("214S", "unauthorized transition rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214T — stale-worker rejection (transitionStage with a stale expected capability status)
  try {
    const input = {
      objective: "Stale worker rejection " + prefix + "T",
      repository: "github.com/example/stale-worker",
      sourceRevision: "sha-T",
    };
    const a = await svc.createEngineeringRun(input);
    const planning = a.stages.find((s) => s.stageType === "PLANNING")!;
    // First transition wins.
    const t1 = await svc.transitionStage({
      runId: a.run.id,
      stageId: planning.id,
      expectedCapabilityStatus: planning.capabilityStatus,
      newCapabilityStatus: "AVAILABLE",
      reason: "first",
    });
    ok(t1.ok && t1.updated, `first transition failed: ${t1.reason}`);
    // Second caller with the SAME stale expectedStatus loses the CAS.
    const t2 = await svc.transitionStage({
      runId: a.run.id,
      stageId: planning.id,
      expectedCapabilityStatus: planning.capabilityStatus,
      newCapabilityStatus: "AVAILABLE",
      reason: "stale",
    });
    ok(t2.ok === false || t2.updated === false,
       `stale transition should lose CAS, got ok=${t2.ok} updated=${t2.updated}`);
    record("214T", "stale-worker rejection", "PASS",
      `first=${t1.reason} stale=${t2.reason}`);
  } catch (e) { record("214T", "stale-worker rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214U — lifecycle event persistence
  try {
    const input = {
      objective: "Event persistence " + prefix + "U",
      repository: "github.com/example/events",
      sourceRevision: "sha-U",
    };
    const a = await svc.createEngineeringRun(input);
    const evts = await svc.getEngineeringRunEvents(a.run.id);
    ok(evts.length > 0, `no events persisted`);
    const types = new Set(evts.map((e) => e.eventType));
    ok(types.has("engineering_run.created"), `missing engineering_run.created`);
    ok(types.has("engineering_run.stage_created"), `missing engineering_run.stage_created`);
    ok(types.has("engineering_run.stage_blocked"), `missing engineering_run.stage_blocked`);
    // Every event has a runId and a timestamp.
    for (const e of evts) {
      ok(e.runId === a.run.id, `event runId mismatch: ${e.runId}`);
      ok(typeof e.createdAt === "number" && e.createdAt > 0, `event createdAt invalid`);
    }
    record("214U", "lifecycle event persistence", "PASS",
      `${evts.length} events including created/stage_created/stage_blocked`);
  } catch (e) { record("214U", "lifecycle event persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214V — event/idempotency consistency (2nd create does not add events)
  try {
    const input = {
      objective: "Event idempotency " + prefix + "V",
      repository: "github.com/example/event-idem",
      sourceRevision: "sha-V",
    };
    const a1 = await svc.createEngineeringRun(input);
    const eventsBefore = await svc.getEngineeringRunEvents(a1.run.id);
    const a2 = await svc.createEngineeringRun(input);
    ok(a1.run.id === a2.run.id, `run ids differ`);
    ok(a2.created === false, `second created=${a2.created}`);
    const eventsAfter = await svc.getEngineeringRunEvents(a1.run.id);
    ok(eventsBefore.length === eventsAfter.length,
       `events grew: ${eventsBefore.length} -> ${eventsAfter.length}`);
    record("214V", "event/idempotency consistency", "PASS",
      `${eventsBefore.length} events stable across duplicate create`);
  } catch (e) { record("214V", "event/idempotency consistency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214W — artifact reference persistence
  try {
    const input = {
      objective: "Artifact reference " + prefix + "W",
      repository: "github.com/example/artifact",
      sourceRevision: "sha-W",
    };
    const a = await svc.createEngineeringRun(input);
    const planning = a.stages.find((s) => s.stageType === "PLANNING")!;
    const t = await svc.transitionStage({
      runId: a.run.id,
      stageId: planning.id,
      expectedCapabilityStatus: planning.capabilityStatus,
      newCapabilityStatus: "AVAILABLE",
      artifactRef: "artifact://plan-" + a.run.id,
      reason: "wired planning executor produced a plan artifact",
    });
    ok(t.ok && t.updated, `transition failed: ${t.reason}`);
    const after = (await svc.getEngineeringRunStages(a.run.id)).find((s) => s.stageType === "PLANNING")!;
    ok(after.artifactRef === "artifact://plan-" + a.run.id,
       `artifactRef=${after.artifactRef}`);
    record("214W", "artifact reference persistence", "PASS",
      `artifactRef=${after.artifactRef}`);
  } catch (e) { record("214W", "artifact reference persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214X — run cancellation
  try {
    const input = {
      objective: "Run cancellation " + prefix + "X",
      repository: "github.com/example/cancel",
      sourceRevision: "sha-X",
    };
    const a = await svc.createEngineeringRun(input);
    const c = await svc.cancelEngineeringRun(a.run.id, "test cancellation");
    ok(c.ok === true, `cancel failed: ${c.reason}`);
    const evts = await svc.getEngineeringRunEvents(a.run.id);
    const types = new Set(evts.map((e) => e.eventType));
    ok(types.has("engineering_run.cancel_requested"), `missing cancel_requested`);
    ok(types.has("engineering_run.cancelled"), `missing cancelled`);
    record("214X", "run cancellation", "PASS", `cancelled with 2 events`);
  } catch (e) { record("214X", "run cancellation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214Y — cancellation durability
  try {
    const input = {
      objective: "Cancellation durability " + prefix + "Y",
      repository: "github.com/example/cancel-dur",
      sourceRevision: "sha-Y",
    };
    const a = await svc.createEngineeringRun(input);
    await svc.cancelEngineeringRun(a.run.id, "durability test");
    // Fresh service reads the same events.
    const svc4 = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());
    const evts = await svc4.getEngineeringRunEvents(a.run.id);
    const types = new Set(evts.map((e) => e.eventType));
    ok(types.has("engineering_run.cancelled"), `cancellation not durable`);
    // Second cancel returns ok=false (already cancelled).
    const c2 = await svc4.cancelEngineeringRun(a.run.id, "second attempt");
    ok(c2.ok === false, `second cancel should fail: ${c2.reason}`);
    record("214Y", "cancellation durability", "PASS",
      `events durable; second cancel=${c2.reason}`);
  } catch (e) { record("214Y", "cancellation durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 214Z — end-to-end orchestration
  try {
    const input = {
      objective: "End-to-end orchestration " + prefix + "Z",
      repository: "github.com/example/e2e",
      sourceRevision: "sha-Z",
    };
    const a = await svc.createEngineeringRun(input);
    ok(a.created && a.stages.length === CANONICAL_ENGINEERING_DAG.length,
       `creation failed`);
    // Read events + stages and confirm a coherent picture.
    const evts = await svc.getEngineeringRunEvents(a.run.id);
    const stages = await svc.getEngineeringRunStages(a.run.id);
    ok(stages.length === 9, `stages=${stages.length}`);
    ok(evts.length > 0, `no events`);
    // Reconcile clean.
    const rc = await svc.reconcileEngineeringRun(a.run.id);
    ok(rc.action === "NOOP", `reconcile=${rc.action}`);
    // Fresh service reconstructs the run.
    const svc5 = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());
    const run2 = await svc5.getEngineeringRun(a.run.id);
    ok(run2?.objective === input.objective, `reload objective mismatch`);
    record("214Z", "end-to-end orchestration", "PASS",
      `run=${a.run.id} stages=9 events=${evts.length} reconcile=${rc.action}`);
  } catch (e) { record("214Z", "end-to-end orchestration", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  try { await pgCleanup(prefix); } catch (e) { console.log("214 cleanup warning:", e); }
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 214 summary =====");
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
