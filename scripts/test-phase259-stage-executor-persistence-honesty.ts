// scripts/test-phase259-stage-executor-persistence-honesty.ts
// Phase 259 — engineering-stage executor persistence honesty.
//
// Verifies that when a durable write fails (store throws, CAS rejected,
// stage transition rejected, journal write fails), the executor does NOT
// return { ok: true } as if the transition were persisted.
//
// Regression tests 259A-259F.

import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringCapabilityRegistry } from "../src/core/engineering-capability-registry";
import { EngineeringStageExecutor } from "../src/core/engineering-stage-executor";
import type { EngineeringPlanningOrchestrator } from "../src/core/engineering-planning-orchestrator";
import type { EngineeringImplementationOrchestrator } from "../src/core/engineering-implementation-orchestrator";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
const DB = () => process.env.DATABASE_URL!;

async function cleanup(prefix: string) {
  const c = new PgClient(); await c.connect(DB());
  try {
    const tg: [string, string][] = [
      ["engineering_run_events", "run_id"],
      ["engineering_run_stages", "run_id"],
      ["engineering_runs", "id"],
      ["execution_events", "job_id"],
      ["execution_stage_dependencies", "execution_id"],
      ["execution_jobs", "id"],
    ];
    for (const [t, col] of tg) {
      try { await c.query(`DELETE FROM ${t} WHERE ${col} LIKE $1`, [prefix + "%"]); } catch {}
    }
  } finally { await c.close(); }
}

function fakePBlocked(): EngineeringPlanningOrchestrator {
  return {
    submitRequest: async () => ({ request: { id: "ereq-f-" + Date.now() }, created: true }),
    runPlanning: async () => ({ status: "BLOCKED", plan: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [] }),
    runArchitecture: async () => ({ status: "BLOCKED", architecture: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [] }),
    getLatestPlan: async () => null,
    getLatestArchitecture: async () => null,
  } as unknown as EngineeringPlanningOrchestrator;
}
function fakeIBlocked(): EngineeringImplementationOrchestrator {
  return {
    runImplementation: async () => ({ status: "BLOCKED", spec: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [], affectedPaths: [], artifactId: null }),
  } as unknown as EngineeringImplementationOrchestrator;
}

// Wrap a store so the recoverJobAtomicAsync call fails on command.
function storeFailingCas(real: any, mode: "throw" | "reject"): any {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "recoverJobAtomicAsync") {
        return async () => {
          if (mode === "throw") throw new Error("simulated store outage");
          return { ok: false };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Wrap runService so transitionStage returns {ok:false,updated:false} on command.
function runServiceRejectingTransition(real: any): any {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "transitionStage") {
        return async () => ({ ok: false, updated: false, reason: "STALE" });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function main() {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-259-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} db=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    rec("259A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return;
  }
  const realStore = (kernel as any).executionStore as any;
  if (!shared || !hasDb || !realStore) {
    rec("259A", "environment", "BLOCKED", "requires shared mode + DATABASE_URL");
    return;
  }

  const dbUrl = DB();
  const reg = new EngineeringCapabilityRegistry(undefined, undefined, { wiredStages: EngineeringStageExecutor.wiredStages() });
  const realRunSvc = new EngineeringRunService(dbUrl, realStore, reg);

  const freshRun = async (tag: string) => {
    const r = await realRunSvc.createEngineeringRun({
      objective: `Phase259 ${tag} ${prefix}${tag}`,
      repository: "github.com/example/phase259",
      sourceRevision: "sha-" + prefix + tag,
    });
    if (!r.created) throw new Error("run not created");
    return r.run.id;
  };

  // 259A — recoverJobAtomicAsync throws → executor must return {ok:false}
  {
    try {
      const runId = await freshRun("A259");
      const failingStore = storeFailingCas(realStore, "throw");
      const runSvc = new EngineeringRunService(dbUrl, failingStore, reg);
      const e = new EngineeringStageExecutor({ store: failingStore, runService: runSvc, planning: fakePBlocked(), implementation: fakeIBlocked() });
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
      ok(o.ok === false, "expected ok:false, got " + JSON.stringify(o));
      ok(String(o.reason).indexOf("PERSISTENCE") >= 0, "expected PERSISTENCE reason, got " + o.reason);
      rec("259A", "store throws -> ok:false", "PASS", "reason=" + o.reason);
    } catch (ex) { rec("259A", "store throws -> ok:false", "FAIL", String(ex)); }
  }

  // 259B — recoverJobAtomicAsync returns {ok:false} → same
  {
    try {
      const runId = await freshRun("B259");
      const failingStore = storeFailingCas(realStore, "reject");
      const runSvc = new EngineeringRunService(dbUrl, failingStore, reg);
      const e = new EngineeringStageExecutor({ store: failingStore, runService: runSvc, planning: fakePBlocked(), implementation: fakeIBlocked() });
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
      ok(o.ok === false, "expected ok:false, got " + JSON.stringify(o));
      ok(String(o.reason).indexOf("PERSISTENCE") >= 0, "expected PERSISTENCE reason, got " + o.reason);
      rec("259B", "CAS rejected -> ok:false", "PASS", "reason=" + o.reason);
    } catch (ex) { rec("259B", "CAS rejected -> ok:false", "FAIL", String(ex)); }
  }

  // 259C — transitionStage rejected → executor must not claim SUCCEEDED
  {
    try {
      const runId = await freshRun("C259");
      const rejectingRunSvc = runServiceRejectingTransition(realRunSvc);
      const planning: any = {
        submitRequest: async () => ({ request: { id: "ereq-259C" }, created: true }),
        runPlanning: async () => ({ status: "SUCCEEDED", plan: { planId: "plan-259C", runId, status: "VALID" }, reason: "OK", validationErrors: [] }),
        runArchitecture: async () => ({ status: "BLOCKED", architecture: null, reason: "X", validationErrors: [] }),
        getLatestPlan: async () => null,
        getLatestArchitecture: async () => null,
      };
      const e = new EngineeringStageExecutor({ store: realStore, runService: rejectingRunSvc, planning, implementation: fakeIBlocked() });
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
      ok(o.ok === false, "expected ok:false, got " + JSON.stringify(o));
      rec("259C", "transitionStage rejected -> ok:false", "PASS", "reason=" + o.reason);
    } catch (ex) { rec("259C", "transitionStage rejected -> ok:false", "FAIL", String(ex)); }
  }

  // 259D — happy path unchanged: SUCCEEDED flows through
  {
    try {
      const runId = await freshRun("D259");
      const planning: any = {
        submitRequest: async () => ({ request: { id: "ereq-259D" }, created: true }),
        runPlanning: async () => ({ status: "SUCCEEDED", plan: { planId: "plan-259D", runId, status: "VALID" }, reason: "OK", validationErrors: [] }),
        runArchitecture: async () => ({ status: "BLOCKED", architecture: null, reason: "X", validationErrors: [] }),
        getLatestPlan: async () => null,
        getLatestArchitecture: async () => null,
      };
      const e = new EngineeringStageExecutor({ store: realStore, runService: realRunSvc, planning, implementation: fakeIBlocked() });
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
      ok(o.ok === true && o.status === "SUCCEEDED", "expected SUCCEEDED, got " + JSON.stringify(o));
      const j = await realStore.getJobAsync(runId + "__PLANNING");
      ok(j && j.status === "SUCCEEDED", "job not persisted SUCCEEDED: " + (j && j.status));
      rec("259D", "happy path unchanged", "PASS", "status=SUCCEEDED job=SUCCEEDED");
    } catch (ex) { rec("259D", "happy path unchanged", "FAIL", String(ex)); }
  }

  // 259E — Phase 258 behavior preserved: dependency throw → ok:true FAILED
  {
    try {
      const runId = await freshRun("E259");
      const planning: any = {
        submitRequest: async () => ({ request: { id: "ereq-259E" }, created: true }),
        runPlanning: async () => { throw new Error("simulated throw"); },
        runArchitecture: async () => ({ status: "BLOCKED", architecture: null, reason: "X", validationErrors: [] }),
        getLatestPlan: async () => null,
        getLatestArchitecture: async () => null,
      };
      const e = new EngineeringStageExecutor({ store: realStore, runService: realRunSvc, planning, implementation: fakeIBlocked() });
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
      ok(o.ok === true && o.status === "FAILED", "expected FAILED, got " + JSON.stringify(o));
      ok(String(o.reason).startsWith("PLANNING_EXECUTOR_THREW:"), "reason=" + o.reason);
      rec("259E", "Phase 258 behavior preserved", "PASS", "reason=" + o.reason);
    } catch (ex) { rec("259E", "Phase 258 behavior preserved", "FAIL", String(ex)); }
  }

  // 259F — BLOCKED path with failing store must not claim persisted BLOCKED
  {
    try {
      const runId = await freshRun("F259");
      const failingStore = storeFailingCas(realStore, "throw");
      const runSvc = new EngineeringRunService(dbUrl, failingStore, reg);
      const e = new EngineeringStageExecutor({ store: failingStore, runService: runSvc, planning: fakePBlocked(), implementation: fakeIBlocked() });
      // ARCHITECTURE with upstream PLANNING not SUCCEEDED hits the BLOCKED path.
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: "ARCHITECTURE" });
      ok(o.ok === false, "expected ok:false, got " + JSON.stringify(o));
      rec("259F", "BLOCKED not persisted -> ok:false", "PASS", "reason=" + o.reason);
    } catch (ex) { rec("259F", "BLOCKED not persisted -> ok:false", "FAIL", String(ex)); }
  }

  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch {}
  try { await cleanup(prefix); } catch (e) { console.log("cleanup warning:", e); }

  const counts = rows.reduce<Record<R, number>>((a, r) => { a[r.r] = (a[r.r] ?? 0) + 1; return a; }, { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 });
  console.log("");
  console.log("===== Phase 259 summary =====");
  console.log("PASS: " + counts.PASS);
  console.log("FAIL: " + counts.FAIL);
  console.log("BLOCKED: " + counts.BLOCKED);
  console.log("NOT EXECUTED: " + counts["NOT EXECUTED"]);
  if (counts.FAIL > 0) process.exitCode = 1;
}

main().catch(e => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(2); });