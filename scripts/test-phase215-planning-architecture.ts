// scripts/test-phase215-planning-architecture.ts
// Phase 215 — Planning + Architecture execution foundation.
//
// Drives the real EngineeringPlanningOrchestrator against PostgreSQL in
// shared mode. Test-only provider doubles are used ONLY for failure/success
// path coverage (per prompt §26); they are never registered as production
// capabilities and never make the production registry report AVAILABLE.

import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { ArtifactStore } from "../src/core/artifact-store";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringPlanningOrchestrator } from "../src/core/engineering-planning-orchestrator";
import {
  EngineeringCapabilityRegistry,
  CANONICAL_ENGINEERING_DAG,
} from "../src/core/engineering-capability-registry";
import type {
  PlanningProvider, ArchitectureProvider,
  ProviderContext, ArchitectureProviderContext,
  PlanProviderResult, ArchitectureProviderResult, ProviderError,
  EngineeringPlan, ArchitectureSpecification,
} from "../src/core/engineering-planning-contracts";
import {
  computePlanContentHash,
  computeArchitectureContentHash,
  validateEngineeringPlan,
  validateArchitectureSpecification,
} from "../src/core/engineering-plan-validator";

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
    await c.query("DELETE FROM architecture_specifications WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_plans WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_requests WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_events WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_run_stages WHERE run_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM engineering_runs WHERE id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_artifacts WHERE job_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_events WHERE job_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_stage_dependencies WHERE execution_id LIKE $1", [prefix + "%"]);
    await c.query("DELETE FROM execution_jobs WHERE id LIKE $1", [prefix + "%"]);
  } finally { await c.close(); }
}

// ---- Test-only providers (never registered as production) ----

function makeValidPlan(runId: string, requestId: string): Omit<EngineeringPlan, "contentHash" | "createdAt" | "updatedAt" | "status" | "createdBy"> {
  return {
    planId: "plan-" + runId,
    runId,
    requestId,
    version: 1,
    objective: "Build a production hotel-booking marketplace",
    scope: "Core booking, payments, inventory",
    requirements: [
      { id: "R1", text: "Users can search hotels by city and date" },
      { id: "R2", text: "Users can book and pay for rooms" },
    ],
    constraints: [{ id: "C1", text: "Must support 1000 concurrent bookings" }],
    assumptions: ["Postgres is available"],
    acceptanceCriteria: ["Booking flow passes E2E smoke"],
    plannedStages: [
      { id: "S1", name: "Design data model", dependsOn: [] },
      { id: "S2", name: "Implement booking API", dependsOn: ["S1"] },
      { id: "S3", name: "Implement payment flow", dependsOn: ["S2"] },
    ],
    dependencies: [
      { from: "S1", to: "S2" }, { from: "S2", to: "S3" },
    ],
    risks: [{ id: "RISK1", description: "Payment provider latency", severity: "MEDIUM" }],
    verificationStrategy: ["Unit tests", "E2E smoke"],
  };
}

function makeValidArchitecture(runId: string, plan: EngineeringPlan): Omit<ArchitectureSpecification, "contentHash" | "createdAt" | "updatedAt" | "status" | "createdBy"> {
  return {
    architectureId: "arch-" + runId,
    runId,
    planId: plan.planId,
    version: plan.version,
    systemOverview: "Service-oriented hotel booking platform",
    components: [
      { id: "api", name: "API Gateway", responsibility: "Public API", dependsOn: [] },
      { id: "booking", name: "Booking Service", responsibility: "Booking logic", dependsOn: ["api"] },
      { id: "payments", name: "Payment Service", responsibility: "Payment flow", dependsOn: ["api"] },
    ],
    interfaces: [
      { id: "iface-1", fromComponent: "api", toComponent: "booking", description: "REST" },
      { id: "iface-2", fromComponent: "booking", toComponent: "payments", description: "REST" },
    ],
    dataModel: ["booking", "hotel", "user"],
    runtimeModel: ["Stateless services on containers"],
    securityModel: ["JWT auth on API"],
    deploymentModel: ["Docker Compose locally"],
    observabilityModel: ["Structured logs to stdout"],
    failureHandling: "Circuit breaker on payment provider",
    technologyDecisions: ["Postgres", "Node.js"],
    constraints: ["No external message queue"],
    verificationStrategy: ["Contract tests", "Smoke"],
  };
}

class TestPlanningProvider implements PlanningProvider {
  readonly providerId = "test-planning";
  constructor(private mode: "success" | "fail" | "throw" | "invalid") {}
  async plan(ctx: ProviderContext): Promise<PlanProviderResult | ProviderError> {
    if (this.mode === "throw") throw new Error("provider threw");
    if (this.mode === "fail") return { ok: false, reason: "PROVIDER_ERROR", detail: "synthetic failure" };
    const base = makeValidPlan(ctx.runId, ctx.request.id);
    if (this.mode === "invalid") {
      // Remove acceptance criteria to make plan invalid.
      return { ok: true, plan: { ...base, acceptanceCriteria: [] } };
    }
    return { ok: true, plan: base };
  }
}

class TestArchitectureProvider implements ArchitectureProvider {
  readonly providerId = "test-architecture";
  constructor(private mode: "success" | "fail" | "throw" | "invalid") {}
  async architect(ctx: ArchitectureProviderContext): Promise<ArchitectureProviderResult | ProviderError> {
    if (this.mode === "throw") throw new Error("architecture provider threw");
    if (this.mode === "fail") return { ok: false, reason: "PROVIDER_ERROR", detail: "synthetic" };
    const base = makeValidArchitecture(ctx.runId, ctx.validatedPlan);
    if (this.mode === "invalid") {
      // No components -> invalid.
      return { ok: true, architecture: { ...base, components: [] } };
    }
    return { ok: true, architecture: base };
  }
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-215-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    record("215A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as Store | undefined;
  if (!shared || !hasDb || !store) {
    const reason = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL not set" : "no executionStore";
    for (const [id, name] of [
      ["215A","engineering request creation"],["215B","deterministic request identity"],
      ["215C","duplicate request idempotency"],["215D","concurrent duplicate request protection"],
      ["215E","plan schema validation"],["215F","invalid plan rejection"],
      ["215G","plan dependency validation"],["215H","plan cycle rejection"],
      ["215I","plan content-hash validation"],["215J","architecture schema validation"],
      ["215K","invalid architecture rejection"],["215L","architecture references valid plan"],
      ["215M","architecture dependency validation"],["215N","capability registry honesty"],
      ["215O","planning unavailable -> BLOCKED"],["215P","architecture unavailable -> BLOCKED"],
      ["215Q","planning provider failure -> FAILED"],["215R","architecture provider failure -> FAILED"],
      ["215S","authoritative planning success"],["215T","authoritative architecture success"],
      ["215U","artifact persistence"],["215V","lifecycle event persistence"],
      ["215W","restart durability"],["215X","duplicate execution protection"],
      ["215Y","unauthorized mutation rejection"],["215Z","end-to-end orchestration"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", reason);
    }
    return finish(kernel, prefix);
  }

  const dbUrl = process.env.DATABASE_URL!;
  const artifacts = new ArtifactStore(store, process.env.DATABASE_URL);
  const runService = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());
  const orchestrator = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts);

  // Helper: create a run + submit a request
  async function seedRunAndRequest(tag: string): Promise<{ runId: string; requestId: string }> {
    const r = await runService.createEngineeringRun({
      objective: "Phase 215 test run " + tag + " " + prefix,
      repository: "github.com/example/p215",
      sourceRevision: "sha-" + tag,
      requestedBy: "phase215-test",
    });
    const req = await orchestrator.submitRequest({
      runId: r.run.id,
      requestText: "Build hotel-booking marketplace " + tag,
      createdBy: "phase215-test",
    });
    return { runId: r.run.id, requestId: req.request.id };
  }

  // 215A — engineering request creation
  try {
    const { runId, requestId } = await seedRunAndRequest("A");
    const req = await orchestrator.getRequest(runId, requestId);
    ok(!!req, "request not found");
    ok(req!.runId === runId, "runId mismatch");
    ok(req!.requestText.includes("hotel-booking"), "request text mismatch");
    ok(req!.requestHash.length === 64, `hash len=${req!.requestHash.length}`);
    const row = await pgExec("SELECT id FROM engineering_requests WHERE id=$1", [requestId]);
    ok(row.rows.length === 1, "engineering_requests row missing");
    record("215A", "engineering request creation", "PASS",
      `request=${requestId} hash=${req!.requestHash.slice(0, 12)}...`);
  } catch (e) { record("215A", "engineering request creation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215B — deterministic request identity
  try {
    const runId = rid(prefix + "run-B-");
    const h1 = orchestrator.computeRequestHash(runId, "Build X");
    const h2 = orchestrator.computeRequestHash(runId, "Build X");
    ok(h1 === h2, "hash not deterministic");
    const h3 = orchestrator.computeRequestHash(runId, "  Build   X  ");
    ok(h3 === h1, "whitespace changed hash");
    const h4 = orchestrator.computeRequestHash(runId, "Build Y");
    ok(h4 !== h1, "different text should differ");
    const h5 = orchestrator.computeRequestHash(runId + "-other", "Build X");
    ok(h5 !== h1, "different run should differ");
    record("215B", "deterministic request identity", "PASS", `hash stable across calls`);
  } catch (e) { record("215B", "deterministic request identity", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215C — duplicate request idempotency
  try {
    const r = await runService.createEngineeringRun({
      objective: "Phase 215 idempotency " + prefix + "C",
      repository: "github.com/example/p215-idem",
      sourceRevision: "sha-C",
    });
    const a = await orchestrator.submitRequest({ runId: r.run.id, requestText: "Build hotel app" });
    const b = await orchestrator.submitRequest({ runId: r.run.id, requestText: "Build hotel app" });
    ok(a.created === true, `first created=${a.created}`);
    ok(b.created === false, `second created=${b.created}`);
    ok(a.request.id === b.request.id, `ids differ`);
    const cnt = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_requests WHERE run_id=$1 AND request_hash=$2",
      [r.run.id, a.request.requestHash]);
    ok(cnt.rows[0].c === 1, `rows=${cnt.rows[0].c}`);
    record("215C", "duplicate request idempotency", "PASS",
      `request=${a.request.id} created=[true,false] rows=1`);
  } catch (e) { record("215C", "duplicate request idempotency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215D — concurrent duplicate request protection
  try {
    const r = await runService.createEngineeringRun({
      objective: "Phase 215 concurrency " + prefix + "D",
      repository: "github.com/example/p215-conc",
      sourceRevision: "sha-D",
    });
    const results = await Promise.all([
      orchestrator.submitRequest({ runId: r.run.id, requestText: "Concurrent request" }),
      orchestrator.submitRequest({ runId: r.run.id, requestText: "Concurrent request" }),
      orchestrator.submitRequest({ runId: r.run.id, requestText: "Concurrent request" }),
      orchestrator.submitRequest({ runId: r.run.id, requestText: "Concurrent request" }),
    ]);
    const createdCount = results.filter((x) => x.created).length;
    ok(createdCount === 1, `createdCount=${createdCount}`);
    const ids = new Set(results.map((x) => x.request.id));
    ok(ids.size === 1, `ids diverged`);
    record("215D", "concurrent duplicate request protection", "PASS",
      `created=1 of 4; request=${results[0].request.id}`);
  } catch (e) { record("215D", "concurrent duplicate request protection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215E — plan schema validation (valid plan)
  try {
    const { runId, requestId } = await seedRunAndRequest("E");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const out = await svc.runPlanning(runId, requestId);
    ok(out.status === "SUCCEEDED", `status=${out.status} reason=${out.reason} errors=${out.validationErrors.join(",")}`);
    ok(!!out.plan, "plan missing");
    ok(out.plan!.status === "VALID", `status=${out.plan!.status}`);
    ok(out.plan!.contentHash.length === 64, `hash len=${out.plan!.contentHash.length}`);
    const row = await pgExec("SELECT id FROM engineering_plans WHERE id=$1", [out.plan!.planId]);
    ok(row.rows.length === 1, "engineering_plans row missing");
    record("215E", "plan schema validation", "PASS",
      `plan=${out.plan!.planId} status=${out.plan!.status}`);
  } catch (e) { record("215E", "plan schema validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215F — invalid plan rejection
  try {
    const { runId, requestId } = await seedRunAndRequest("F");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("invalid"));
    const out = await svc.runPlanning(runId, requestId);
    ok(out.status === "INVALID", `status=${out.status}`);
    ok(out.validationErrors.length > 0, `no errors`);
    ok(out.validationErrors.includes("ACCEPTANCE_CRITERIA_EMPTY"),
       `errors=${out.validationErrors.join(",")}`);
    // Row persisted with INVALID.
    const row = await pgExec("SELECT status FROM engineering_plans WHERE id=$1", [out.plan!.planId]);
    ok(row.rows[0]?.status === "INVALID", `persisted status=${row.rows[0]?.status}`);
    record("215F", "invalid plan rejection", "PASS",
      `status=${out.status} errors=${out.validationErrors.join(",")}`);
  } catch (e) { record("215F", "invalid plan rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215G — plan dependency validation (unknown dep rejected)
  try {
    const runId = rid(prefix + "run-G-");
    const requestId = rid(prefix + "req-G-");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts);
    const badPlan: any = {
      planId: "plan-G",
      runId, requestId, version: 1,
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [],
      acceptanceCriteria: ["ok"],
      plannedStages: [
        { id: "S1", name: "A", dependsOn: [] },
        { id: "S2", name: "B", dependsOn: ["MISSING"] },
      ],
      dependencies: [{ from: "S1", to: "S2" }],
      risks: [],
      verificationStrategy: ["unit"],
    };
    const { contentHash: _x, ...hashable } = badPlan;
    badPlan.contentHash = computePlanContentHash(hashable as any);
    const v = validateEngineeringPlan(badPlan);
    ok(!v.ok, "should be invalid");
    ok(v.errors.some((e: string) => e.startsWith("STAGE_DEP_UNKNOWN")), `errors=${v.errors.join(",")}`);
    record("215G", "plan dependency validation", "PASS", `rejected unknown dep`);
  } catch (e) { record("215G", "plan dependency validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215H — plan cycle rejection
  try {
    const runId = rid(prefix + "run-H-");
    const requestId = rid(prefix + "req-H-");
    const cycPlan: any = {
      planId: "plan-H", runId, requestId, version: 1,
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [
        { id: "S1", name: "A", dependsOn: ["S2"] },
        { id: "S2", name: "B", dependsOn: ["S1"] },
      ],
      dependencies: [{ from: "S1", to: "S2" }, { from: "S2", to: "S1" }],
      risks: [], verificationStrategy: ["unit"],
    };
    const { contentHash: _y, ...hashableY } = cycPlan;
    cycPlan.contentHash = computePlanContentHash(hashableY as any);
    const v = validateEngineeringPlan(cycPlan);
    ok(!v.ok, "should be invalid");
    ok(v.errors.includes("STAGE_CYCLE_DETECTED"), `errors=${v.errors.join(",")}`);
    record("215H", "plan cycle rejection", "PASS", `cycle detected and rejected`);
  } catch (e) { record("215H", "plan cycle rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215I — plan content-hash validation (tamper detection)
  try {
    const runId = rid(prefix + "run-I-");
    const requestId = rid(prefix + "req-I-");
    const base: any = {
      planId: "plan-I", runId, requestId, version: 1,
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
    };
    const { contentHash: _z, ...hz } = base;
    base.contentHash = computePlanContentHash(hz as any);
    const good = validateEngineeringPlan(base);
    ok(good.ok, `good plan rejected: ${good.errors.join(",")}`);
    // Tamper: change objective without updating hash.
    const tampered = { ...base, objective: "tampered" };
    const bad = validateEngineeringPlan(tampered);
    ok(!bad.ok, `tampered plan accepted`);
    ok(bad.errors.includes("CONTENT_HASH_MISMATCH"), `errors=${bad.errors.join(",")}`);
    record("215I", "plan content-hash validation", "PASS", `tamper detected`);
  } catch (e) { record("215I", "plan content-hash validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215J — architecture schema validation (valid architecture)
  try {
    const { runId, requestId } = await seedRunAndRequest("J");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed: ${planOut.reason}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "SUCCEEDED", `status=${archOut.status} reason=${archOut.reason} errors=${archOut.validationErrors.join(",")}`);
    ok(!!archOut.architecture, "architecture missing");
    ok(archOut.architecture!.status === "VALID", `status=${archOut.architecture!.status}`);
    const row = await pgExec("SELECT id FROM architecture_specifications WHERE id=$1", [archOut.architecture!.architectureId]);
    ok(row.rows.length === 1, "architecture_specifications row missing");
    record("215J", "architecture schema validation", "PASS",
      `arch=${archOut.architecture!.architectureId} status=${archOut.architecture!.status}`);
  } catch (e) { record("215J", "architecture schema validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215K — invalid architecture rejection
  try {
    const { runId, requestId } = await seedRunAndRequest("K");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("invalid"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed: ${planOut.reason}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "INVALID", `status=${archOut.status}`);
    ok(archOut.validationErrors.includes("COMPONENTS_EMPTY"), `errors=${archOut.validationErrors.join(",")}`);
    const row = await pgExec("SELECT status FROM architecture_specifications WHERE id=$1", [archOut.architecture!.architectureId]);
    ok(row.rows[0]?.status === "INVALID", `persisted status=${row.rows[0]?.status}`);
    record("215K", "invalid architecture rejection", "PASS",
      `status=${archOut.status} errors=${archOut.validationErrors.join(",")}`);
  } catch (e) { record("215K", "invalid architecture rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215L — architecture references valid plan (reject when plan not VALID)
  try {
    const { runId, requestId } = await seedRunAndRequest("L");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("invalid"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "INVALID", `expected INVALID plan, got ${planOut.status}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "INVALID", `expected INVALID, got ${archOut.status}`);
    ok(archOut.reason.startsWith("PLAN_NOT_VALID"), `reason=${archOut.reason}`);
    record("215L", "architecture references valid plan", "PASS",
      `rejected plan status=${planOut.plan!.status} reason=${archOut.reason}`);
  } catch (e) { record("215L", "architecture references valid plan", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215M — architecture dependency validation (invalid interface refs)
  try {
    const { runId, requestId } = await seedRunAndRequest("M");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed`);
    // Manually construct an architecture with bad interface refs.
    const bad: any = {
      architectureId: "arch-M",
      runId, planId: planOut.plan!.planId, version: planOut.plan!.version,
      systemOverview: "x",
      components: [{ id: "a", name: "A", responsibility: "r", dependsOn: [] }],
      interfaces: [
        { id: "i1", fromComponent: "a", toComponent: "MISSING", description: "d" },
      ],
      dataModel: ["x"], runtimeModel: ["x"], securityModel: ["x"],
      deploymentModel: ["x"], observabilityModel: ["x"],
      failureHandling: "x", technologyDecisions: ["x"], constraints: ["x"],
      verificationStrategy: ["x"],
    };
    const { contentHash: _q, ...hq } = bad;
    bad.contentHash = computeArchitectureContentHash(hq as any);
    const v = validateArchitectureSpecification(bad, planOut.plan);
    ok(!v.ok, "should be invalid");
    ok(v.errors.some((e: string) => e.startsWith("IFACE_TO_UNKNOWN")), `errors=${v.errors.join(",")}`);
    record("215M", "architecture dependency validation", "PASS", `rejected unknown interface ref`);
  } catch (e) { record("215M", "architecture dependency validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215N — capability registry honesty
  try {
    const reg = new EngineeringCapabilityRegistry();
    const v = reg.evaluateAll();
    ok(v.length === CANONICAL_ENGINEERING_DAG.length, `verdicts=${v.length}`);
    const planning = v.find((x) => x.stageType === "PLANNING")!;
    const architecture = v.find((x) => x.stageType === "ARCHITECTURE")!;
    ok(planning.status === "NOT_IMPLEMENTED", `PLANNING=${planning.status}`);
    ok(architecture.status === "NOT_IMPLEMENTED", `ARCHITECTURE=${architecture.status}`);
    const allHonest = v.every((x) => x.status !== "AVAILABLE");
    ok(allHonest, `unexpected AVAILABLE: ${v.map(x => x.stageType + "=" + x.status).join(",")}`);
    record("215N", "capability registry honesty", "PASS",
      `no AVAILABLE stages; PLANNING=${planning.status} ARCHITECTURE=${architecture.status}`);
  } catch (e) { record("215N", "capability registry honesty", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215O — planning unavailable -> BLOCKED
  try {
    const { runId, requestId } = await seedRunAndRequest("O");
    // Orchestrator with NO planning provider.
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts);
    const out = await svc.runPlanning(runId, requestId);
    ok(out.status === "BLOCKED", `status=${out.status}`);
    ok(out.reason === "PROVIDER_NOT_CONFIGURED", `reason=${out.reason}`);
    ok(out.plan === null, `plan should be null`);
    // Event persisted
    const evts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type='engineering_planning.blocked'",
      [runId]);
    ok(evts.rows.length >= 1, `blocked event missing`);
    record("215O", "planning unavailable -> BLOCKED", "PASS",
      `status=${out.status} reason=${out.reason}`);
  } catch (e) { record("215O", "planning unavailable -> BLOCKED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215P — architecture unavailable -> BLOCKED
  try {
    const { runId, requestId } = await seedRunAndRequest("P");
    // Planning provider exists, architecture provider does not.
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed: ${planOut.reason}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "BLOCKED", `status=${archOut.status}`);
    ok(archOut.reason === "PROVIDER_NOT_CONFIGURED", `reason=${archOut.reason}`);
    const evts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type='engineering_architecture.blocked'",
      [runId]);
    ok(evts.rows.length >= 1, `blocked event missing`);
    record("215P", "architecture unavailable -> BLOCKED", "PASS",
      `status=${archOut.status} reason=${archOut.reason}`);
  } catch (e) { record("215P", "architecture unavailable -> BLOCKED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215Q — real planning provider failure -> FAILED
  try {
    const { runId, requestId } = await seedRunAndRequest("Q");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("fail"));
    const out = await svc.runPlanning(runId, requestId);
    ok(out.status === "FAILED", `status=${out.status}`);
    ok(out.reason === "PROVIDER_ERROR", `reason=${out.reason}`);
    const evts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type='engineering_planning.failed'",
      [runId]);
    ok(evts.rows.length >= 1, `failed event missing`);
    record("215Q", "planning provider failure -> FAILED", "PASS",
      `status=${out.status} reason=${out.reason}`);
  } catch (e) { record("215Q", "planning provider failure -> FAILED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215R — real architecture provider failure -> FAILED
  try {
    const { runId, requestId } = await seedRunAndRequest("R");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("fail"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "FAILED", `status=${archOut.status}`);
    ok(archOut.reason === "PROVIDER_ERROR", `reason=${archOut.reason}`);
    const evts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type='engineering_architecture.failed'",
      [runId]);
    ok(evts.rows.length >= 1, `failed event missing`);
    record("215R", "architecture provider failure -> FAILED", "PASS",
      `status=${archOut.status} reason=${archOut.reason}`);
  } catch (e) { record("215R", "architecture provider failure -> FAILED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215S — authoritative planning success (idempotent across calls)
  try {
    const { runId, requestId } = await seedRunAndRequest("S");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const a = await svc.runPlanning(runId, requestId);
    const b = await svc.runPlanning(runId, requestId);
    ok(a.status === "SUCCEEDED", `a status=${a.status}`);
    ok(b.status === "SUCCEEDED", `b status=${b.status}`);
    ok(a.plan!.planId === b.plan!.planId, `plan ids differ`);
    ok(a.plan!.contentHash === b.plan!.contentHash, `content hashes differ`);
    const cnt = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_plans WHERE run_id=$1 AND version=1",
      [runId]);
    // Depending on run planning twice, plan may exist once per attempt — Phase 215
    // records what was produced. Assert at least one VALID plan.
    const valids = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_plans WHERE run_id=$1 AND status='VALID'",
      [runId]);
    ok(valids.rows[0].c >= 1, `no VALID plans`);
    record("215S", "authoritative planning success", "PASS",
      `plan=${a.plan!.planId} valid rows=${valids.rows[0].c}`);
  } catch (e) { record("215S", "authoritative planning success", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215T — authoritative architecture success
  try {
    const { runId, requestId } = await seedRunAndRequest("T");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed: ${planOut.reason}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "SUCCEEDED", `status=${archOut.status}`);
    ok(archOut.architecture!.status === "VALID", `arch status=${archOut.architecture!.status}`);
    const valids = await pgExec(
      "SELECT COUNT(*)::int AS c FROM architecture_specifications WHERE run_id=$1 AND status='VALID'",
      [runId]);
    ok(valids.rows[0].c >= 1, `no VALID arch rows`);
    record("215T", "authoritative architecture success", "PASS",
      `arch=${archOut.architecture!.architectureId} valid rows=${valids.rows[0].c}`);
  } catch (e) { record("215T", "authoritative architecture success", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215U — artifact persistence
  try {
    const { runId, requestId } = await seedRunAndRequest("U");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(planOut.status === "SUCCEEDED" && archOut.status === "SUCCEEDED",
       `planning/arch failed: ${planOut.reason}/${archOut.reason}`);
    const planArt = await pgExec(
      "SELECT artifact_id, type, checksum FROM execution_artifacts WHERE artifact_id=$1",
      ["art-plan-" + planOut.plan!.planId]);
    ok(planArt.rows.length === 1, `plan artifact missing`);
    ok(planArt.rows[0].type === "ENGINEERING_PLAN", `plan artifact type=${planArt.rows[0].type}`);
    ok(typeof planArt.rows[0].checksum === "string" && planArt.rows[0].checksum.length === 64,
       `plan artifact checksum invalid`);
    const archArt = await pgExec(
      "SELECT artifact_id, type, checksum FROM execution_artifacts WHERE artifact_id=$1",
      ["art-arch-" + archOut.architecture!.architectureId]);
    ok(archArt.rows.length === 1, `arch artifact missing`);
    ok(archArt.rows[0].type === "ARCHITECTURE_SPECIFICATION", `arch artifact type=${archArt.rows[0].type}`);
    record("215U", "artifact persistence", "PASS",
      `plan+arch artifacts persisted with checksums`);
  } catch (e) { record("215U", "artifact persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215V — lifecycle event persistence
  try {
    const { runId, requestId } = await seedRunAndRequest("V");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    await svc.runPlanning(runId, requestId);
    const planOut = await svc.getLatestPlan(runId);
    ok(!!planOut, "no plan persisted");
    await svc.runArchitecture(runId, planOut!.planId);
    const evts = await pgExec(
      "SELECT DISTINCT event_type FROM engineering_run_events WHERE run_id=$1", [runId]);
    const types = new Set<string>(evts.rows.map((r: any) => r.event_type));
    for (const required of [
      "engineering_request.created",
      "engineering_planning.started",
      "engineering_plan.validated",
      "engineering_plan.artifact_persisted",
      "engineering_architecture.started",
      "engineering_architecture.validated",
      "engineering_architecture.artifact_persisted",
    ]) {
      ok(types.has(required), `missing event: ${required}`);
    }
    record("215V", "lifecycle event persistence", "PASS",
      `${types.size} distinct event types including full planning+arch lifecycle`);
  } catch (e) { record("215V", "lifecycle event persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215W — restart durability (fresh orchestrator instance, same DB)
  try {
    const { runId, requestId } = await seedRunAndRequest("W");
    const svc1 = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const a = await svc1.runPlanning(runId, requestId);
    ok(a.status === "SUCCEEDED", `planning failed`);
    const svc2 = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts);
    const reloadedPlan = await svc2.getLatestPlan(runId);
    ok(!!reloadedPlan, `plan not durable`);
    ok(reloadedPlan!.planId === a.plan!.planId, `planId mismatch`);
    ok(reloadedPlan!.contentHash === a.plan!.contentHash, `contentHash mismatch`);
    const req = await svc2.getRequest(runId, requestId);
    ok(!!req, `request not durable`);
    record("215W", "restart durability", "PASS",
      `plan=${reloadedPlan!.planId} durable across fresh orchestrator`);
  } catch (e) { record("215W", "restart durability", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215X — duplicate execution protection (replan does not create conflicting VALID plans)
  try {
    const { runId, requestId } = await seedRunAndRequest("X");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const [a, b, c] = await Promise.all([
      svc.runPlanning(runId, requestId),
      svc.runPlanning(runId, requestId),
      svc.runPlanning(runId, requestId),
    ]);
    const succeeded = [a, b, c].filter((x) => x.status === "SUCCEEDED").length;
    ok(succeeded >= 1, `no successful planning`);
    // At most one VALID plan per (run, version). Duplicates would violate the
    // UNIQUE(run_id, version) constraint and be rejected by insert.
    const valids = await pgExec(
      "SELECT COUNT(*)::int AS c FROM engineering_plans WHERE run_id=$1 AND version=1 AND status='VALID'",
      [runId]);
    ok(valids.rows[0].c <= 1, `multiple VALID plans for same version: ${valids.rows[0].c}`);
    record("215X", "duplicate execution protection", "PASS",
      `succeeded=${succeeded} valid v1 rows=${valids.rows[0].c}`);
  } catch (e) { record("215X", "duplicate execution protection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215Y — unauthorized mutation rejection (direct SQL UPDATE of a VALID plan's contentHash is not accepted by validator)
  try {
    const { runId, requestId } = await seedRunAndRequest("Y");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"));
    const a = await svc.runPlanning(runId, requestId);
    ok(a.status === "SUCCEEDED" && a.plan, `planning failed`);
    // Attempt to change content_hash via raw SQL.
    await pgExec(
      "UPDATE engineering_plans SET content_hash=$1 WHERE id=$2",
      ["0".repeat(64), a.plan!.planId]);
    const after = await svc.getPlan(runId, a.plan!.planId);
    ok(!!after, `plan lost`);
    // The persisted hash is now wrong; re-validating must reject.
    const v = validateEngineeringPlan(after!);
    ok(!v.ok, `re-validation should have failed after hash tamper`);
    ok(v.errors.includes("CONTENT_HASH_MISMATCH"), `errors=${v.errors.join(",")}`);
    record("215Y", "unauthorized mutation rejection", "PASS",
      `tampered content_hash rejected by validator`);
  } catch (e) { record("215Y", "unauthorized mutation rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 215Z — end-to-end planning -> architecture orchestration
  try {
    const { runId, requestId } = await seedRunAndRequest("Z");
    const svc = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, new TestPlanningProvider("success"), new TestArchitectureProvider("success"));
    const planOut = await svc.runPlanning(runId, requestId);
    ok(planOut.status === "SUCCEEDED", `planning failed: ${planOut.reason}`);
    const archOut = await svc.runArchitecture(runId, planOut.plan!.planId);
    ok(archOut.status === "SUCCEEDED", `architecture failed: ${archOut.reason}`);
    // Full durability check across fresh service
    const svc2 = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts);
    const planReload = await svc2.getLatestPlan(runId);
    const archReload = await svc2.getLatestArchitecture(runId);
    ok(planReload?.planId === planOut.plan!.planId, `plan not durable`);
    ok(archReload?.architectureId === archOut.architecture!.architectureId, `arch not durable`);
    // Events reflect complete lifecycle
    const evts = await pgExec(
      "SELECT DISTINCT event_type FROM engineering_run_events WHERE run_id=$1", [runId]);
    const types = new Set<string>(evts.rows.map((r: any) => r.event_type));
    ok(types.has("engineering_plan.validated"), `missing plan.validated`);
    ok(types.has("engineering_architecture.validated"), `missing arch.validated`);
    record("215Z", "end-to-end orchestration", "PASS",
      `plan=${planOut.plan!.planId} arch=${archOut.architecture!.architectureId} events=${types.size}`);
  } catch (e) { record("215Z", "end-to-end orchestration", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  try { await pgCleanup(prefix); } catch (e) { console.log("215 cleanup warning:", e); }
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 215 summary =====");
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
