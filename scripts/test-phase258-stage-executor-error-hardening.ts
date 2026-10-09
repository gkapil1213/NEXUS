// scripts/test-phase258-stage-execution.ts
// Phase 258 — engineering-stage executor wiring.
import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringCapabilityRegistry, CANONICAL_ENGINEERING_DAG } from "../src/core/engineering-capability-registry";
import { EngineeringStageExecutor } from "../src/core/engineering-stage-executor";
import { EngineeringPlanningOrchestrator } from "../src/core/engineering-planning-orchestrator";
import { EngineeringImplementationOrchestrator } from "../src/core/engineering-implementation-orchestrator";

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED";
const rows: { id: string; name: string; r: R; n: string }[] = [];
function rec(id: string, name: string, r: R, n: string) {
  rows.push({ id, name, r, n });
  const m = r === "PASS" ? "[PASS]" : r === "FAIL" ? "[FAIL]" : r === "BLOCKED" ? "[BLK ]" : "[N/E ]";
  console.log(`${m} ${id} ${name} -- ${n}`);
}
function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
const DB = () => process.env.DATABASE_URL!;

async function q(sql: string, p: unknown[] = []) {
  const c = new PgClient(); await c.connect(DB());
  try { return await c.query(sql, p); } finally { await c.close(); }
}

async function cleanup(prefix: string) {
  const c = new PgClient(); await c.connect(DB());
  try {
    const tg: [string, string][] = [
      ["engineering_run_events", "run_id"],
      ["engineering_run_stages", "run_id"],
      ["engineering_runs", "id"],
      ["engineering_plans", "run_id"],
      ["architecture_specifications", "run_id"],
      ["engineering_requests", "run_id"],
      ["implementation_specifications", "run_id"],
      ["execution_events", "job_id"],
      ["execution_stage_dependencies", "execution_id"],
      ["execution_jobs", "id"],
    ];
    for (const [t, col] of tg) {
      try { await c.query(`DELETE FROM ${t} WHERE ${col} LIKE $1`, [prefix + "%"]); } catch {}
    }
  } finally { await c.close(); }
}

function fakeP(calls: string[], o: { plan?: any; arch?: any; po?: any; ao?: any } = {}): EngineeringPlanningOrchestrator {
  return {
    submitRequest: async () => { calls.push("submitRequest"); return { request: { id: "ereq-f-" + Date.now() }, created: true }; },
    runPlanning: async () => { calls.push("runPlanning"); return o.po ?? { status: "BLOCKED", plan: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [] }; },
    runArchitecture: async () => { calls.push("runArchitecture"); return o.ao ?? { status: "BLOCKED", architecture: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [] }; },
    getLatestPlan: async () => { calls.push("getLatestPlan"); return o.plan ?? null; },
    getLatestArchitecture: async () => { calls.push("getLatestArchitecture"); return o.arch ?? null; },
  } as unknown as EngineeringPlanningOrchestrator;
}
function fakeI(calls: string[], out?: any): EngineeringImplementationOrchestrator {
  return {
    runImplementation: async () => {
      calls.push("runImplementation");
      return out ?? { status: "BLOCKED", spec: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [], affectedPaths: [], artifactId: null };
    },
  } as unknown as EngineeringImplementationOrchestrator;
}

async function main() {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-258-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} db=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    rec("218A", "executor construction", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as any;
  const artifacts = (kernel as any).artifactStore as any;
  const workspaces = (kernel as any).workspaceService as any;

  if (!shared || !hasDb || !store) {
    const why = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL unset" : "no executionStore";
    const ids: [string, string][] = [
      ["218A","executor construction"],["218B","registry reflects wiring"],
      ["218C","PLANNING dispatch"],["218D","ARCHITECTURE dispatch"],["218E","IMPLEMENTATION dispatch"],
      ["218F","ARCH gated by PLAN"],["218G","IMPL gated by ARCH"],["218H","unknown stage rejected"],
      ["218I","run ownership"],["218J","transitions durable"],["218K","events persisted"],
      ["218L","retry idempotency"],["218M","provider absence"],["218N","failure -> FAIL"],
      ["218O","no secrets"],["218P","DAG unchanged"],
    ];
    for (const [id, n] of ids) rec(id, n, "BLOCKED", why);
    return finish(kernel, prefix);
  }

  const dbUrl = DB();
  const reg = new EngineeringCapabilityRegistry(undefined, undefined, { wiredStages: EngineeringStageExecutor.wiredStages() });
  const runSvc = new EngineeringRunService(dbUrl, store, reg);

  const freshRun = async (tag: string) => {
    const r = await runSvc.createEngineeringRun({
      objective: `Phase218 ${tag} ${prefix}${tag}`,
      repository: "github.com/example/phase218",
      sourceRevision: "sha-" + prefix + tag,
    });
    if (!r.created) throw new Error("run not created");
    return r.run.id;
  };

  const forceSucceeded = async (runId: string, stage: string) => {
    const jid = runId + "__" + stage;
    const j = await store.getJobAsync(jid);
    await store.recoverJobAtomicAsync({
      jobId: jid, expectedStatus: j.status, newStatus: "SUCCEEDED",
      expectedLeaseId: null, patch: {},
      event: { eventType: "engineering_run.stage_succeeded", payload: { force: true } },
    });
  };

  // ---- Phase 258: thrown dependencies become durable FAILED outcomes ----

  const fakePThrow = (which: string, err: Error): EngineeringPlanningOrchestrator => {
    const boom = async () => { throw err; };
    const blocked = async () => ({ status: "BLOCKED", plan: null, architecture: null, reason: "X", validationErrors: [] });
    return {
      submitRequest:         which === "submitRequest"         ? boom : async () => ({ request: { id: "ereq-258" }, created: true }),
      runPlanning:           which === "runPlanning"           ? boom : blocked,
      runArchitecture:       which === "runArchitecture"       ? boom : blocked,
      getLatestPlan:         which === "getLatestPlan"         ? boom : async () => ({ planId: "p258", runId: "r", status: "VALID" }),
      getLatestArchitecture: which === "getLatestArchitecture" ? boom : async () => ({ architectureId: "a258", runId: "r", planId: "p258", status: "VALID" }),
    } as unknown as EngineeringPlanningOrchestrator;
  };

  const fakeIThrow = (which: string, err: Error): EngineeringImplementationOrchestrator => ({
    runImplementation: which === "runImplementation"
      ? async () => { throw err; }
      : async () => ({ status: "BLOCKED", spec: null, reason: "X", validationErrors: [], affectedPaths: [], artifactId: null }),
  } as unknown as EngineeringImplementationOrchestrator);

  const expectThrew = async (id: string, name: string, stage: string, runId: string, e: EngineeringStageExecutor) => {
    try {
      const o = await e.execute({ kind: "engineering.stage", runId, stageType: stage as any });
      ok(o.ok === true, "expected structured outcome, got " + JSON.stringify(o));
      if (o.ok) {
        ok(o.status === "FAILED", "status=" + o.status);
        ok(o.reason.startsWith(stage + "_EXECUTOR_THREW:"), "reason=" + o.reason);
        ok(o.reason.indexOf("simulated") >= 0, "message not propagated: " + o.reason);
      }
      const j = await store.getJobAsync(runId + "__" + stage);
      ok(j && j.status === "FAILED", "job=" + (j && j.status));
      rec(id, name, "PASS", "reason=" + (o.ok ? o.reason : ""));
    } catch (ex) { rec(id, name, "FAIL", String(ex)); }
  };

  { const runId = await freshRun("A258");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("submitRequest", new Error("simulated submitRequest outage")),
      implementation: fakeIThrow("", new Error("unused")) });
    await expectThrew("258A", "PLANNING submitRequest throws", "PLANNING", runId, e); }

  { const runId = await freshRun("B258");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("runPlanning", new Error("simulated runPlanning outage")),
      implementation: fakeIThrow("", new Error("unused")) });
    await expectThrew("258B", "PLANNING runPlanning throws", "PLANNING", runId, e); }

  { const runId = await freshRun("C258"); await forceSucceeded(runId, "PLANNING");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("getLatestPlan", new Error("simulated getLatestPlan outage")),
      implementation: fakeIThrow("", new Error("unused")) });
    await expectThrew("258C", "ARCHITECTURE getLatestPlan throws", "ARCHITECTURE", runId, e); }

  { const runId = await freshRun("D258"); await forceSucceeded(runId, "PLANNING");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("runArchitecture", new Error("simulated runArchitecture outage")),
      implementation: fakeIThrow("", new Error("unused")) });
    await expectThrew("258D", "ARCHITECTURE runArchitecture throws", "ARCHITECTURE", runId, e); }

  { const runId = await freshRun("E258"); await forceSucceeded(runId, "PLANNING"); await forceSucceeded(runId, "ARCHITECTURE");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("getLatestArchitecture", new Error("simulated getLatestArchitecture outage")),
      implementation: fakeIThrow("", new Error("unused")),
      workspaceResolver: async () => ({ workspaceId: "ws-f", actor: { id: "t", kind: "system" } as any }) });
    await expectThrew("258E", "IMPLEMENTATION getLatestArchitecture throws", "IMPLEMENTATION", runId, e); }

  { const runId = await freshRun("F258"); await forceSucceeded(runId, "PLANNING"); await forceSucceeded(runId, "ARCHITECTURE");
    const e = new EngineeringStageExecutor({ store, runService: runSvc,
      planning: fakePThrow("", new Error("unused")),
      implementation: fakeIThrow("runImplementation", new Error("simulated runImplementation outage")),
      workspaceResolver: async () => ({ workspaceId: "ws-f", actor: { id: "t", kind: "system" } as any }) });
    await expectThrew("258F", "IMPLEMENTATION runImplementation throws", "IMPLEMENTATION", runId, e); }

  return finish(kernel, prefix);
async function finish(kernel: NexusKernel, prefix: string) {
  try { await kernel.stopDistributedScheduler(); } catch {}
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch {}
  try { await cleanup(prefix); } catch (e) { console.log("cleanup warning:", e); }
  const c = rows.reduce<Record<R, number>>((a, r) => { a[r.r] = (a[r.r] ?? 0) + 1; return a; }, { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 });
  console.log("\n===== Phase 218 summary =====");
  console.log("PASS: " + c.PASS);
  console.log("FAIL: " + c.FAIL);
  console.log("BLOCKED: " + c.BLOCKED);
  console.log("NOT EXECUTED: " + c["NOT EXECUTED"]);
  if (c.FAIL > 0) process.exitCode = 1;
}

main().catch(e => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(2); });
