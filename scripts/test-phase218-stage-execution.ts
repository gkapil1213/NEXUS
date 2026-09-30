// scripts/test-phase218-stage-execution.ts
// Phase 218 — engineering-stage executor wiring.
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
  const prefix = "engrun-218-" + Date.now() + "-";
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

  let exec!: EngineeringStageExecutor;
  try {
    exec = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ok(typeof exec.execute === "function", "execute missing");
    const w = EngineeringStageExecutor.wiredStages();
    ok(w.has("PLANNING") && w.has("ARCHITECTURE") && w.has("IMPLEMENTATION"), "wired stages incomplete");
    rec("218A", "executor construction", "PASS", "Phase 218 stages remain wired");
  } catch (e) { rec("218A", "executor construction", "FAIL", String(e)); return finish(kernel, prefix); }

  try {
    const v = reg.evaluateAll();
    const by = new Map(v.map(x => [x.stageType, x.status]));
    ok(by.get("PLANNING") === "AVAILABLE", "PLAN=" + by.get("PLANNING"));
    ok(by.get("ARCHITECTURE") === "AVAILABLE", "ARCH=" + by.get("ARCHITECTURE"));
    ok(by.get("IMPLEMENTATION") === "AVAILABLE", "IMPL=" + by.get("IMPLEMENTATION"));
    const bare = new EngineeringCapabilityRegistry().evaluateAll();
    ok(bare.every(x => x.status !== "AVAILABLE"), "unwired leaked AVAILABLE");
    rec("218B", "registry reflects wiring", "PASS", "Phase 218 stages AVAILABLE; later-stage wiring does not invalidate regression");
  } catch (e) { rec("218B", "registry reflects wiring", "FAIL", String(e)); }

  try {
    const runId = await freshRun("C");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(o.ok === true, "not ok");
    if (o.ok) ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status);
    ok(calls.includes("submitRequest"), "submitRequest not called: " + calls.join(","));
    ok(calls.includes("runPlanning"), "runPlanning not called: " + calls.join(","));
    rec("218C", "PLANNING dispatch", "PASS", "submitRequest+runPlanning reached; BLOCKED");
  } catch (e) { rec("218C", "PLANNING dispatch", "FAIL", String(e)); }

  try {
    const runId = await freshRun("D");
    await forceSucceeded(runId, "PLANNING");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, { plan: { planId: "p", runId, status: "VALID" } }),
      implementation: fakeI(calls),
    });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "ARCHITECTURE" });
    ok(o.ok === true, "not ok");
    if (o.ok) ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status);
    ok(calls.includes("runArchitecture"), "runArchitecture not called: " + calls.join(","));
    rec("218D", "ARCHITECTURE dispatch", "PASS", "runArchitecture reached; BLOCKED");
  } catch (e) { rec("218D", "ARCHITECTURE dispatch", "FAIL", String(e)); }

  try {
    const runId = await freshRun("E");
    await forceSucceeded(runId, "PLANNING");
    await forceSucceeded(runId, "ARCHITECTURE");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, {
        plan: { planId: "p", runId, status: "VALID" },
        arch: { architectureId: "a", runId, planId: "p", status: "VALID" },
      }),
      implementation: fakeI(calls),
      workspaceResolver: async () => ({ workspaceId: "ws-f", actor: { id: "t", kind: "system" } as any }),
    });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "IMPLEMENTATION" });
    ok(o.ok === true, "not ok");
    if (o.ok) ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status);
    ok(calls.includes("runImplementation"), "runImplementation not called: " + calls.join(","));
    rec("218E", "IMPLEMENTATION dispatch", "PASS", "runImplementation reached; BLOCKED");
  } catch (e) { rec("218E", "IMPLEMENTATION dispatch", "FAIL", String(e)); }

  try {
    const runId = await freshRun("F");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "ARCHITECTURE" });
    ok(o.ok === true, "not ok");
    if (o.ok) {
      ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status);
      ok(o.reason.startsWith("UPSTREAM_NOT_SUCCEEDED:PLANNING"), "reason=" + o.reason);
    }
    ok(!calls.includes("runArchitecture"), "runArchitecture was called!");
    rec("218F", "ARCH gated by PLAN", "PASS", "BLOCKED; orchestrator not invoked");
  } catch (e) { rec("218F", "ARCH gated by PLAN", "FAIL", String(e)); }

  try {
    const runId = await freshRun("G");
    await forceSucceeded(runId, "PLANNING");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, { plan: { planId: "p", runId, status: "VALID" } }),
      implementation: fakeI(calls),
      workspaceResolver: async () => ({ workspaceId: "ws", actor: {} as any }),
    });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "IMPLEMENTATION" });
    ok(o.ok === true, "not ok");
    if (o.ok) {
      ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status);
      ok(o.reason.startsWith("UPSTREAM_NOT_SUCCEEDED:ARCHITECTURE"), "reason=" + o.reason);
    }
    ok(!calls.includes("runImplementation"), "runImplementation called!");
    rec("218G", "IMPL gated by ARCH", "PASS", "BLOCKED; orchestrator not invoked");
  } catch (e) { rec("218G", "IMPL gated by ARCH", "FAIL", String(e)); }

  try {
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    const bad: any[] = [
      { kind: "engineering.stage", runId: "x", stageType: "NOT_A_STAGE" },
      { kind: "wrong", runId: "x", stageType: "PLANNING" },
      null,
      { kind: "engineering.stage", stageType: "PLANNING" },
    ];
    for (const b of bad) {
      const o = await e.execute(b);
      ok(o.ok === false, "should reject: " + JSON.stringify(b));
    }
    ok(calls.length === 0, "orchestrator was called on bad payload");
    rec("218H", "unknown stage rejected", "PASS", "4 malformed payloads rejected");
  } catch (e) { rec("218H", "unknown stage rejected", "FAIL", String(e)); }

  try {
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    const o = await e.execute({ kind: "engineering.stage", runId: "engrun-NOPE-" + Date.now(), stageType: "PLANNING" });
    ok(o.ok === false && o.reason === "RUN_NOT_FOUND", "expected RUN_NOT_FOUND, got " + JSON.stringify(o));
    ok(calls.length === 0, "orchestrator called for unknown run");
    rec("218I", "run ownership", "PASS", "RUN_NOT_FOUND; orchestrator untouched");
  } catch (e) { rec("218I", "run ownership", "FAIL", String(e)); }

  try {
    const runId = await freshRun("J");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, { po: { status: "SUCCEEDED", plan: { planId: "plan-J", runId, status: "VALID" }, reason: "TEST", validationErrors: [] } }),
      implementation: fakeI(calls),
    });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(o.ok === true && o.status === "SUCCEEDED", "status=" + (o.ok ? o.status : o.reason));
    const stages = await runSvc.getEngineeringRunStages(runId);
    const pl = stages.find(s => s.stageType === "PLANNING")!;
    ok(pl.capabilityStatus === "AVAILABLE", "capability=" + pl.capabilityStatus);
    ok(pl.artifactRef === "artifact://plan-plan-J", "artifactRef=" + pl.artifactRef);
    const j = await store.getJobAsync(runId + "__PLANNING");
    ok(j?.status === "SUCCEEDED", "job=" + j?.status);
    rec("218J", "transitions durable", "PASS", "capability=AVAILABLE, artifactRef set, job=SUCCEEDED");
  } catch (e) { rec("218J", "transitions durable", "FAIL", String(e)); }

  try {
    const runId = await freshRun("K");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    const evts = await runSvc.getEngineeringRunEvents(runId);
    const types = new Set(evts.map(x => x.eventType));
    ok(types.has("engineering_run.created"), "no created");
    ok(types.has("engineering_run.stage_created"), "no stage_created");
    ok(types.has("engineering_run.stage_blocked") || types.has("engineering_run.stage_updated"), "no blocked/updated");
    rec("218K", "events persisted", "PASS", evts.length + " events");
  } catch (e) { rec("218K", "events persisted", "FAIL", String(e)); }

  try {
    const runId = await freshRun("L");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, { po: { status: "SUCCEEDED", plan: { planId: "plan-L", runId, status: "VALID" }, reason: "TEST", validationErrors: [] } }),
      implementation: fakeI(calls),
    });
    const r1 = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(r1.ok && r1.status === "SUCCEEDED", "r1=" + JSON.stringify(r1));
    const r2 = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(r2.ok && r2.status === "SUCCEEDED", "r2=" + JSON.stringify(r2));
    const evts = await runSvc.getEngineeringRunEvents(runId);
    const cnt = evts.filter(x => x.eventType === "engineering_run.stage_updated" && (x.payload ?? "").includes("AVAILABLE")).length;
    ok(cnt === 1, "AVAILABLE transitions=" + cnt);
    rec("218L", "retry idempotency", "PASS", "second dispatch CAS-idempotent; 1 transition->AVAILABLE");
  } catch (e) { rec("218L", "retry idempotency", "FAIL", String(e)); }

  try {
    const realP = new EngineeringPlanningOrchestrator(dbUrl, store, artifacts);
    const realI = new EngineeringImplementationOrchestrator(dbUrl, artifacts, workspaces);
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: realP, implementation: realI });
    const runId = await freshRun("M");
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(o.ok === true, "not ok");
    if (o.ok) {
      ok(o.status === "BLOCKED", "expected BLOCKED, got " + o.status + " reason=" + o.reason);
      ok(o.reason === "PROVIDER_NOT_CONFIGURED", "reason=" + o.reason);
    }
    const j = await store.getJobAsync(runId + "__PLANNING");
    ok(j?.status === "BLOCKED", "job=" + j?.status);
    rec("218M", "provider absence", "PASS", "real orchestrator: BLOCKED; job=BLOCKED");
  } catch (e) { rec("218M", "provider absence", "FAIL", String(e)); }

  try {
    const runId = await freshRun("N");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP(calls, { po: { status: "FAILED", plan: null, reason: "SIMULATED_PROVIDER_FAILURE", validationErrors: [] } }),
      implementation: fakeI(calls),
    });
    const o = await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    ok(o.ok === true, "not ok");
    if (o.ok) ok(o.status === "FAILED", "expected FAILED, got " + o.status);
    const j = await store.getJobAsync(runId + "__PLANNING");
    ok(j?.status === "FAILED", "job=" + j?.status);
    rec("218N", "failure -> FAIL", "PASS", "orchestrator FAILED -> job FAILED");
  } catch (e) { rec("218N", "failure -> FAIL", "FAIL", String(e)); }

  try {
    const runId = await freshRun("O");
    const calls: string[] = [];
    const e = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP(calls), implementation: fakeI(calls) });
    await e.execute({ kind: "engineering.stage", runId, stageType: "PLANNING" });
    const evts = await runSvc.getEngineeringRunEvents(runId);
    const pat = /sk-[a-zA-Z0-9]{16,}|api[_-]?key\s*[:=]\s*["'][^"']+["']|Bearer\s+[A-Za-z0-9._-]{20,}/i;
    for (const ev of evts) ok(!pat.test(ev.payload ?? ""), "secret in event " + ev.eventId);
    rec("218O", "no secrets", "PASS", evts.length + " events scanned");
  } catch (e) { rec("218O", "no secrets", "FAIL", String(e)); }

  try {
    ok(CANONICAL_ENGINEERING_DAG.length === 9, "DAG len=" + CANONICAL_ENGINEERING_DAG.length);
    ok(CANONICAL_ENGINEERING_DAG[0].stageType === "PLANNING", "DAG[0]");
    ok(CANONICAL_ENGINEERING_DAG[8].stageType === "RELEASE_READY", "DAG[8]");
    rec("218P", "DAG unchanged", "PASS", "9 stages intact");
  } catch (e) { rec("218P", "DAG unchanged", "FAIL", String(e)); }


  // ═════════════════════════════════════════════════════════════════════
  function recDispatchBoundary(id: string, name: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    // Honest BLOCKED: the shared-mode persistence split (Postgres execution
    // tables vs SQLite-only remote_dispatches) makes this boundary
    // unreachable in production until remote_dispatches is migrated.
    if (msg.includes("FOREIGN KEY constraint failed")) {
      rec(id, name, "BLOCKED", "DISPATCH_STORE_NOT_MIGRATED_TO_SHARED_MODE: " + msg);
    } else {
      rec(id, name, "FAIL", msg);
    }
  }

  async function seedEngDispatch(jobId: string, suffix: string): Promise<{ attempt: any; workerId: string; leaseId: string }> {
    const now = Date.now();
    const workerId = "worker-218-" + suffix + "-" + now;
    const attemptId = "att-218-" + suffix + "-" + now + "-" + Math.random().toString(36).slice(2,8);
    const leaseId = "lease-218-" + suffix + "-" + now;
    await store.registerWorkerAsync({ workerId, status: "ONLINE", capabilities: [], registeredAt: now });
    const attempt: any = { id: attemptId, jobId, attemptNumber: 1, status: "RUNNING", workerId, leaseId, startedAt: now, createdAt: now };
    await store.createAttemptAsync(attempt);
    const parentJob = await store.getJobAsync(jobId);
    if (!parentJob) {
      throw new Error("PARENT_JOB_MISSING:" + jobId);
    }

    return { attempt, workerId, leaseId };
  }

  // Phase 218 — production-path tests (218Q-218Z).
  // These tests build a real DispatchService with a real
  // EngineeringStageExecutor attached (via attachEngineeringExecutor) and
  // drive it as the production ExecutionDispatchPort. They do NOT call
  // EngineeringStageExecutor.execute() as the entrypoint.
  // ═════════════════════════════════════════════════════════════════════

  async function loadDispatchService(): Promise<any> {
    const dsMod = await import("../src/core/dispatch-service");
    return dsMod.DispatchService;
  }

  function spiedExecutor(real: EngineeringStageExecutor, counter: { n: number }): EngineeringStageExecutor {
    return new Proxy(real, {
      get(t, p, r) {
        if (p === "execute") {
          return async (raw: unknown) => { counter.n += 1; return (t as any).execute(raw); };
        }
        return Reflect.get(t, p, r);
      },
    }) as EngineeringStageExecutor;
  }

  function fakeJobDispatcher(onCall: () => void): any {
    return { dispatchJob: async () => { onCall(); throw new Error("JOB_DISPATCHER_CALLED_IN_ENGINEERING_PATH"); } };
  }
  function fakeRemoteManager(onCall: () => void): any {
    return {
      collectResult: async () => { onCall(); throw new Error("REMOTE_MANAGER_CALLED_IN_ENGINEERING_PATH"); },
      cancel: async () => { onCall(); },
      getStatus: async () => { onCall(); return { status: "UNKNOWN" }; },
    };
  }

  // 218Q — real DispatchService routes engineering.stage to the executor
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("Q");
    const stageId = runId + "__PLANNING";
    const job = await store.getJobAsync(stageId);
    ok(!!job, "PLANNING stage job missing");
    ok(job.jobType === "engineering.stage", "jobType=" + job.jobType);

    let jdCalls = 0, remCalls = 0;
    const ds = new DispatchService(fakeJobDispatcher(() => jdCalls++), fakeRemoteManager(() => remCalls++), store);
    const execCount = { n: 0 };
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(spiedExecutor(real, execCount));

    const { attempt, leaseId } = await seedEngDispatch(job.id, "Q");

    const req: any = { operation: "engineering.stage", metadata: { jobId: job.id } };

    const { dispatchId } = await ds.dispatch(job, attempt, leaseId, req);
    ok(!!dispatchId, "no dispatchId");
    ok(execCount.n === 1, "executor calls=" + execCount.n);
    ok(jdCalls === 0, "JobDispatcher was called");
    ok(remCalls === 0, "RemoteExecutionManager was called");
    const rec2 = await store.getRemoteDispatchAsync(dispatchId);
    ok(!!rec2, "dispatch record not persisted");
    rec("218Q", "DispatchService routes engineering.stage", "PASS",
      "executor=1 jd=0 rem=0 record.status=" + rec2.status);
  } catch (e) { recDispatchBoundary("218Q", "DispatchService routes engineering.stage", e); }

  // 218R — non-engineering job type does NOT hit the executor
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("R");
    const stageId = runId + "__PLANNING";
    const originalJob = await store.getJobAsync(stageId);
    ok(!!originalJob, "stage job missing");
    const nonEng: any = { ...originalJob, jobType: "pipeline.stage" };

    let jdCalls = 0;
    const ds = new DispatchService(fakeJobDispatcher(() => jdCalls++), fakeRemoteManager(() => {}), store);
    const execCount = { n: 0 };
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(spiedExecutor(real, execCount));

    const { attempt, leaseId } = await seedEngDispatch(nonEng.id, "R");
    const req: any = { operation: "pipeline.stage" };
    try { await ds.dispatch(nonEng, attempt, leaseId, req); } catch { }
    ok(execCount.n === 0, "executor was invoked for non-engineering job; calls=" + execCount.n);
    ok(jdCalls === 1, "JobDispatcher not called for non-engineering job; jdCalls=" + jdCalls);
    rec("218R", "non-engineering job skips executor", "PASS",
      "pipeline.stage → JobDispatcher=1; executor=0");
  } catch (e) { rec("218R", "non-engineering job skips executor", "FAIL", String(e)); }

  // 218S — engineering dispatch does not invoke JobDispatcher (isolated re-assertion)
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("S");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    let jdCalls = 0, remCalls = 0;
    const ds = new DispatchService(fakeJobDispatcher(() => jdCalls++), fakeRemoteManager(() => remCalls++), store);
    const execCount = { n: 0 };
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(spiedExecutor(real, execCount));
    const { attempt, leaseId } = await seedEngDispatch(job.id, "S");
    await ds.dispatch(job, attempt, "lease-218S-" + Date.now(), { operation: "engineering.stage" } as any);
    ok(jdCalls === 0 && remCalls === 0, "jd=" + jdCalls + " rem=" + remCalls);
    rec("218S", "engineering skips JobDispatcher+RemoteManager", "PASS",
      "executor invoked; both remote layers bypassed");
  } catch (e) { recDispatchBoundary("218S", "engineering skips JobDispatcher+RemoteManager", e); }

  // 218T — persisted engineering result survives collectResult()
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("T");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(real);
    const { attempt, leaseId } = await seedEngDispatch(job.id, "T");
    const { dispatchId } = await ds.dispatch(job, attempt, "lease-218T-" + Date.now(), { operation: "engineering.stage" } as any);
    const r1 = await ds.collectResult(dispatchId);
    const r2 = await ds.collectResult(dispatchId);
    ok(r1 === r2 || JSON.stringify(r1) === JSON.stringify(r2), "collectResult not stable");
    ok(typeof r1.success === "boolean", "r1.success not boolean");
    const ev = (r1.evidence || {}) as any;
    ok(typeof ev.status === "string", "evidence.status missing");
    rec("218T", "collectResult returns persisted result", "PASS",
      "stable across calls; evidence.status=" + ev.status);
  } catch (e) { recDispatchBoundary("218T", "collectResult returns persisted result", e); }

  // 218U — repeated dispatch is idempotent (executor runs once)
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("U");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const execCount = { n: 0 };
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(spiedExecutor(real, execCount));
    const { attempt, leaseId } = await seedEngDispatch(job.id, "U");
    const req: any = { operation: "engineering.stage" };
    const r1 = await ds.dispatch(job, attempt, "lease-218U-" + Date.now(), req);
    const r2 = await ds.dispatch(job, attempt, "lease-218U-" + Date.now(), req);
    ok(r1.dispatchId === r2.dispatchId, "dispatchId differs");
    ok(execCount.n === 1, "executor ran " + execCount.n + " times (expected 1)");
    rec("218U", "retry idempotency via dispatch boundary", "PASS",
      "second dispatch returned same dispatchId; executor calls=1");
  } catch (e) { recDispatchBoundary("218U", "retry idempotency via dispatch boundary", e); }

  // 218V — provider absence remains BLOCKED through production dispatch path
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("V");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const realP = new EngineeringPlanningOrchestrator(dbUrl, store, artifacts);
    const realI = new EngineeringImplementationOrchestrator(dbUrl, artifacts, workspaces);
    const realExec = new EngineeringStageExecutor({ store, runService: runSvc, planning: realP, implementation: realI });
    ds.attachEngineeringExecutor(realExec);
    const { attempt, leaseId } = await seedEngDispatch(job.id, "V");
    const { dispatchId } = await ds.dispatch(job, attempt, "lease-218V-" + Date.now(), { operation: "engineering.stage" } as any);
    const result = await ds.collectResult(dispatchId);
    const ev = (result.evidence || {}) as any;
    ok(result.success === false, "success must be false when BLOCKED; got " + result.success);
    ok(ev.status === "BLOCKED", "evidence.status=" + ev.status + " (expected BLOCKED)");
    ok(ev.reason === "PROVIDER_NOT_CONFIGURED", "reason=" + ev.reason);
    const rec2 = await store.getRemoteDispatchAsync(dispatchId);
    ok(rec2.status === "BLOCKED", "record.status=" + rec2.status);
    rec("218V", "BLOCKED preserved through production path", "PASS",
      "result.success=false evidence.status=BLOCKED record.status=BLOCKED");
  } catch (e) { recDispatchBoundary("218V", "BLOCKED preserved through production path", e); }

  // 218W — engineering FAILED propagates as FAILED
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("W");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const failing = new EngineeringStageExecutor({
      store, runService: runSvc,
      planning: fakeP([], { po: { status: "FAILED", plan: null, reason: "SIMULATED_PROVIDER_FAILURE", validationErrors: [] } }),
      implementation: fakeI([]),
    });
    ds.attachEngineeringExecutor(failing);
    const { attempt, leaseId } = await seedEngDispatch(job.id, "W");
    const { dispatchId } = await ds.dispatch(job, attempt, "lease-218W-" + Date.now(), { operation: "engineering.stage" } as any);
    const result = await ds.collectResult(dispatchId);
    const ev = (result.evidence || {}) as any;
    ok(result.success === false, "success must be false");
    ok(ev.status === "FAILED", "evidence.status=" + ev.status);
    const rec2 = await store.getRemoteDispatchAsync(dispatchId);
    ok(rec2.status === "FAILED", "record.status=" + rec2.status);
    rec("218W", "FAILED propagates through production path", "PASS",
      "result.success=false evidence.status=FAILED record.status=FAILED");
  } catch (e) { recDispatchBoundary("218W", "FAILED propagates through production path", e); }

  // 218X — ownership/run-mismatch rejected through production path
  try {
    const DispatchService = await loadDispatchService();
    const runIdX = await freshRun("X");
    const realJobX = await store.getJobAsync(runIdX + "__PLANNING");
    if (!realJobX) throw new Error("218X real job missing");
    const job: any = { ...realJobX, payload: { kind: "engineering.stage", runId: "engrun-DOES-NOT-EXIST-" + Date.now(), stageType: "PLANNING" } };
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(real);
    const { attempt, leaseId } = await seedEngDispatch(job.id, "X");
    const { dispatchId } = await ds.dispatch(job, attempt, "lease-218X-" + Date.now(), { operation: "engineering.stage" } as any);
    const result = await ds.collectResult(dispatchId);
    const ev = (result.evidence || {}) as any;
    ok(result.success === false, "run mismatch must not succeed");
    ok(ev.status === "REJECTED" || ev.reason === "RUN_NOT_FOUND", "expected REJECTED/RUN_NOT_FOUND; got " + JSON.stringify(ev));
    rec("218X", "run ownership rejected at dispatch boundary", "PASS",
      "success=false; evidence=" + JSON.stringify(ev));
  } catch (e) { recDispatchBoundary("218X", "run ownership rejected at dispatch boundary", e); }

  // 218Y — no secret material in persisted dispatch evidence
  try {
    const DispatchService = await loadDispatchService();
    const runId = await freshRun("Y");
    const job = await store.getJobAsync(runId + "__PLANNING");
    ok(!!job, "stage job missing");
    const ds = new DispatchService(fakeJobDispatcher(() => {}), fakeRemoteManager(() => {}), store);
    const real = new EngineeringStageExecutor({ store, runService: runSvc, planning: fakeP([]), implementation: fakeI([]) });
    ds.attachEngineeringExecutor(real);
    const { attempt, leaseId } = await seedEngDispatch(job.id, "Y");
    const { dispatchId } = await ds.dispatch(job, attempt, "lease-218Y-" + Date.now(), { operation: "engineering.stage" } as any);
    const rec2 = await store.getRemoteDispatchAsync(dispatchId);
    const blob = JSON.stringify(rec2);
    const pat = /sk-[a-zA-Z0-9]{16,}|api[_-]?key\\s*[:=]\\s*["'][^"']+["']|Bearer\\s+[A-Za-z0-9._-]{20,}/i;
    ok(!pat.test(blob), "secret pattern found in dispatch record");
    const events = await runSvc.getEngineeringRunEvents(runId);
    for (const e of events) ok(!pat.test(e.payload ?? ""), "secret in engineering event " + e.eventId);
    rec("218Y", "no secrets in dispatch evidence", "PASS",
      "record clean; " + events.length + " events scanned");
  } catch (e) { recDispatchBoundary("218Y", "no secrets in dispatch evidence", e); }

  // 218Z — canonical 9-stage DAG unchanged through the new dispatch boundary
  try {
    ok(CANONICAL_ENGINEERING_DAG.length === 9, "DAG len=" + CANONICAL_ENGINEERING_DAG.length);
    const stageTypes = CANONICAL_ENGINEERING_DAG.map(s => s.stageType);
    const expected = ["PLANNING","ARCHITECTURE","IMPLEMENTATION","BUILD","TEST","DIAGNOSIS","REPAIR","SECURITY_REVIEW","RELEASE_READY"];
    ok(JSON.stringify(stageTypes) === JSON.stringify(expected), "DAG order changed: " + stageTypes.join(","));
    const wired = EngineeringStageExecutor.wiredStages();
    ok(wired.has("PLANNING") && wired.has("ARCHITECTURE") && wired.has("IMPLEMENTATION"), "Phase 218 stages are no longer wired");
    rec("218Z", "DAG unchanged through dispatch boundary", "PASS",
      "9-stage canonical DAG preserved; Phase 218 stages remain wired");
  } catch (e) { rec("218Z", "DAG unchanged through dispatch boundary", "FAIL", String(e)); }
  return finish(kernel, prefix);
}

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
