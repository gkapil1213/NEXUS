// scripts/test-phase216-ai-provider.ts
// Phase 216 — Production AI provider gateway.
//
// Drives the real gateway against a real HTTP provider adapter where a live
// provider is configured, and against a TEST-ONLY provider double for
// deterministic failure-path coverage. Test doubles never register with the
// production capability registry.

import { NexusKernel } from "../src/core/kernel";
import { PgClient } from "../src/core/pg-client";
import { ArtifactStore } from "../src/core/artifact-store";
import { EngineeringRunService } from "../src/core/engineering-run-service";
import { EngineeringPlanningOrchestrator } from "../src/core/engineering-planning-orchestrator";
import { EngineeringCapabilityRegistry } from "../src/core/engineering-capability-registry";
import { AIProviderGateway } from "../src/core/ai-provider-gateway";
import {
  OpenAICompatibleProvider,
  openAICompatibleConfigFromEnv,
} from "../src/core/ai-provider-openai-compatible";
import { AIPlanningProvider, AIArchitectureProvider } from "../src/core/ai-planning-provider";
import { redactSecrets, redactDeep, bounded } from "../src/core/ai-provider-redaction";
import {
  type AIProvider,
  type AIProviderConfiguration,
  type AIProviderError,
  type AIProviderRequest,
  type AIProviderResponse,
  type AIProviderCapability,
} from "../src/core/ai-provider-contracts";

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

// ---------------- TEST-ONLY provider double ----------------

type BehaviorKind =
  | "success"
  | "timeout"
  | "connection-once-then-success"
  | "auth-failure"
  | "rate-limit"
  | "invalid-json"
  | "no-content"
  | "server-error";

class TestProvider implements AIProvider {
  readonly providerId = "test-provider";
  public invocations = 0;
  public behaviors: BehaviorKind[];
  public structured: unknown;

  constructor(behaviors: BehaviorKind[], structured?: unknown) {
    this.behaviors = behaviors;
    this.structured = structured;
  }

  configuration: AIProviderConfiguration = {
    providerId: "test-provider",
    providerType: "openai-compatible",
    model: "test-model",
    endpoint: "http://test.local/v1",
    apiKeyEnvVar: "TEST_PROVIDER_KEY_NOT_USED",
    timeoutMs: 1000,
    maxRetries: 2,
    enabled: true,
    structuredOutput: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  async probe(): Promise<AIProviderCapability> {
    return {
      providerId: this.providerId,
      status: "AVAILABLE",
      reason: "TEST_DOUBLE_PROBE_OK",
      checkedAt: Date.now(),
      latencyMs: 1,
    };
  }

  async invoke(req: AIProviderRequest): Promise<AIProviderResponse> {
    this.invocations++;
    const kind = this.behaviors[Math.min(this.invocations - 1, this.behaviors.length - 1)];
    if (kind === "timeout") {
      const err: AIProviderError = { errorClass: "TIMEOUT", message: "timed out", retryable: true };
      throw err;
    }
    if (kind === "connection-once-then-success") {
      if (this.invocations === 1) {
        const err: AIProviderError = { errorClass: "CONNECTION", message: "connection refused", retryable: true };
        throw err;
      }
      return this.okResponse(req);
    }
    if (kind === "auth-failure") {
      const err: AIProviderError = { errorClass: "AUTH", message: "invalid credentials", retryable: false };
      (err as { httpStatus?: number }).httpStatus = 401;
      throw err;
    }
    if (kind === "rate-limit") {
      const err: AIProviderError = { errorClass: "RATE_LIMIT", message: "429 too many requests", retryable: true };
      (err as { httpStatus?: number }).httpStatus = 429;
      throw err;
    }
    if (kind === "server-error") {
      const err: AIProviderError = { errorClass: "SERVER", message: "500", retryable: true };
      (err as { httpStatus?: number }).httpStatus = 500;
      throw err;
    }
    if (kind === "invalid-json") {
      return {
        requestId: req.requestId, providerId: this.providerId, model: this.configuration.model,
        content: "not json", structuredOutput: null,
        usage: null, latencyMs: 5, finishReason: "stop", createdAt: Date.now(),
      };
    }
    if (kind === "no-content") {
      return {
        requestId: req.requestId, providerId: this.providerId, model: this.configuration.model,
        content: "", structuredOutput: null,
        usage: null, latencyMs: 5, finishReason: null, createdAt: Date.now(),
      };
    }
    return this.okResponse(req);
  }

  private okResponse(req: AIProviderRequest): AIProviderResponse {
    return {
      requestId: req.requestId,
      providerId: this.providerId,
      model: this.configuration.model,
      content: JSON.stringify(this.structured ?? {}),
      structuredOutput: this.structured ?? {},
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: 5,
      finishReason: "stop",
      createdAt: Date.now(),
    };
  }
}

async function main(): Promise<void> {
  const shared = (process.env.NEXUS_PERSISTENCE_MODE ?? "sqlite").toLowerCase() === "shared";
  const hasDb = !!process.env.DATABASE_URL;
  const prefix = "engrun-216-" + Date.now() + "-";
  console.log(`mode=${shared ? "shared" : "sqlite"} databaseUrl=${hasDb ? "set" : "unset"} prefix=${prefix}`);

  const kernel = new NexusKernel();
  try { await kernel.boot(); } catch (e) {
    record("216A", "kernel boot", "FAIL", e instanceof Error ? e.message : String(e));
    return finish(kernel, prefix);
  }
  const store = (kernel as any).executionStore as Store | undefined;
  if (!shared || !hasDb || !store) {
    const reason = !shared ? "sqlite mode" : !hasDb ? "DATABASE_URL not set" : "no executionStore";
    for (const [id, name] of [
      ["216A","provider interface contract"],["216B","provider configuration validation"],
      ["216C","missing provider configuration"],["216D","provider capability honesty"],
      ["216E","provider runtime probe"],["216F","planning provider wiring"],
      ["216G","architecture provider wiring"],["216H","provider request normalization"],
      ["216I","provider response normalization"],["216J","planning structured-output validation"],
      ["216K","architecture structured-output validation"],["216L","invalid provider response rejection"],
      ["216M","provider timeout handling"],["216N","provider transient failure handling"],
      ["216O","bounded retry behavior"],["216P","non-retryable failure handling"],
      ["216Q","planning provider failure -> FAILED"],["216R","architecture provider failure -> FAILED"],
      ["216S","unavailable provider -> BLOCKED"],["216T","real-provider planning path"],
      ["216U","real-provider architecture path"],["216V","artifact persistence with checksum"],
      ["216W","lifecycle event persistence"],["216X","duplicate execution/idempotency"],
      ["216Y","secret-redaction/security boundary"],["216Z","end-to-end real provider path"],
    ] as Array<[string,string]>) {
      record(id, name, "BLOCKED", reason);
    }
    return finish(kernel, prefix);
  }

  const dbUrl = process.env.DATABASE_URL!;
  const artifacts = new ArtifactStore(store, dbUrl);
  const runService = new EngineeringRunService(dbUrl, store as never, new EngineeringCapabilityRegistry());

  // 216A — provider interface contract
  try {
    const cfg = openAICompatibleConfigFromEnv({} as NodeJS.ProcessEnv);
    const p = new OpenAICompatibleProvider(cfg);
    ok(typeof p.providerId === "string" && p.providerId.length > 0, "providerId missing");
    ok(typeof p.probe === "function", "probe not a function");
    ok(typeof p.invoke === "function", "invoke not a function");
    ok(p.configuration.providerType === "openai-compatible", `providerType=${p.configuration.providerType}`);
    record("216A", "provider interface contract", "PASS", `providerId=${p.providerId}`);
  } catch (e) { record("216A", "provider interface contract", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216B — provider configuration validation
  try {
    const cfg = openAICompatibleConfigFromEnv({
      NEXUS_AI_ENABLED: "true",
      NEXUS_AI_MODEL: "gpt-4o-mini",
      NEXUS_AI_BASE_URL: "https://api.example.com/v1",
      NEXUS_AI_API_KEY_ENV: "MY_TEST_KEY_VAR",
      NEXUS_AI_TIMEOUT_MS: "45000",
      NEXUS_AI_MAX_RETRIES: "3",
    } as any);
    ok(cfg.enabled === true, `enabled=${cfg.enabled}`);
    ok(cfg.model === "gpt-4o-mini", `model=${cfg.model}`);
    ok(cfg.endpoint === "https://api.example.com/v1", `endpoint=${cfg.endpoint}`);
    ok(cfg.apiKeyEnvVar === "MY_TEST_KEY_VAR", `apiKeyEnvVar=${cfg.apiKeyEnvVar}`);
    ok(cfg.timeoutMs === 45000, `timeoutMs=${cfg.timeoutMs}`);
    ok(cfg.maxRetries === 3, `maxRetries=${cfg.maxRetries}`);
    record("216B", "provider configuration validation", "PASS",
      `model=${cfg.model} endpoint=${cfg.endpoint} timeout=${cfg.timeoutMs} retries=${cfg.maxRetries}`);
  } catch (e) { record("216B", "provider configuration validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216C — missing provider configuration
  try {
    const cfg = openAICompatibleConfigFromEnv({} as NodeJS.ProcessEnv);
    ok(cfg.enabled === false, `default enabled should be false, got ${cfg.enabled}`);
    // Even if enabled=true but no model, must be disabled.
    const cfg2 = openAICompatibleConfigFromEnv({ NEXUS_AI_ENABLED: "true" } as any);
    ok(cfg2.enabled === false, `enabled without model should be false, got ${cfg2.enabled}`);
    record("216C", "missing provider configuration", "PASS",
      `default enabled=false; enabled-without-model stays false`);
  } catch (e) { record("216C", "missing provider configuration", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216D — provider capability honesty
  try {
    // Static registry with no gateway: PLANNING / ARCHITECTURE remain NOT_IMPLEMENTED.
    const reg = new EngineeringCapabilityRegistry();
    const staticPlanning = reg.evaluate("PLANNING");
    ok(staticPlanning.status === "NOT_IMPLEMENTED", `static=${staticPlanning.status}`);
    // Async registry with gateway but no provider registered: UNAVAILABLE with
    // PROVIDER_NOT_CONFIGURED.
    const emptyGateway = new AIProviderGateway({ providers: [] });
    const reg2 = new EngineeringCapabilityRegistry(undefined, {
      gateway: emptyGateway,
      planningProviderId: "openai-compatible",
      architectureProviderId: "openai-compatible",
    });
    const asyncPlanning = await reg2.evaluateAsync("PLANNING");
    ok(asyncPlanning.status === "UNAVAILABLE", `async=${asyncPlanning.status}`);
    ok(asyncPlanning.reason === "PROVIDER_NOT_CONFIGURED", `reason=${asyncPlanning.reason}`);
    const asyncArchitecture = await reg2.evaluateAsync("ARCHITECTURE");
    ok(asyncArchitecture.status === "UNAVAILABLE", `arch=${asyncArchitecture.status}`);
    record("216D", "provider capability honesty", "PASS",
      `static=NOT_IMPLEMENTED, gateway-without-provider=UNAVAILABLE/PROVIDER_NOT_CONFIGURED`);
  } catch (e) { record("216D", "provider capability honesty", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216E — provider runtime probe
  try {
    // Enabled but missing API key env var → UNAVAILABLE/PROVIDER_NOT_CONFIGURED
    // without any network call.
    const cfg = openAICompatibleConfigFromEnv({
      NEXUS_AI_ENABLED: "true",
      NEXUS_AI_MODEL: "gpt-4o-mini",
      NEXUS_AI_API_KEY_ENV: "PHASE_216_NONEXISTENT_KEY_VAR",
    } as any);
    const p = new OpenAICompatibleProvider(cfg);
    const result = await p.probe();
    ok(result.status === "UNAVAILABLE", `status=${result.status}`);
    ok(result.reason === "PROVIDER_NOT_CONFIGURED", `reason=${result.reason}`);
    // Disabled → UNAVAILABLE/PROVIDER_DISABLED
    const cfg2 = openAICompatibleConfigFromEnv({ NEXUS_AI_ENABLED: "false" } as any);
    const p2 = new OpenAICompatibleProvider(cfg2);
    const result2 = await p2.probe();
    ok(result2.status === "UNAVAILABLE", `status2=${result2.status}`);
    ok(result2.reason === "PROVIDER_DISABLED", `reason2=${result2.reason}`);
    record("216E", "provider runtime probe", "PASS",
      `missing key → ${result.reason}; disabled → ${result2.reason}`);
  } catch (e) { record("216E", "provider runtime probe", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216F — planning provider wiring (test-only double proves the gateway path)
  try {
    const gateway = new AIProviderGateway({
      providers: [new TestProvider(["success"], {
        objective: "x", scope: "x",
        requirements: [{ id: "R1", text: "r" }],
        constraints: [{ id: "C1", text: "c" }],
        assumptions: [],
        acceptanceCriteria: ["ok"],
        plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
        dependencies: [], risks: [], verificationStrategy: ["unit"],
      })],
    });
    const planning = new AIPlanningProvider(gateway, "test-provider");
    const ctx = {
      runId: "run-F",
      request: {
        id: "req-F", runId: "run-F", requestText: "build x",
        requestHash: "0".repeat(64), createdBy: null, metadata: null, createdAt: Date.now(),
      },
    };
    const r = await planning.plan(ctx as never);
    ok(r.ok === true, `plan() failed: ${!r.ok ? r.reason : "?"}`);
    if (r.ok) ok(r.plan.objective === "x", `objective=${r.plan.objective}`);
    record("216F", "planning provider wiring", "PASS",
      `AIPlanningProvider over gateway succeeded (test double)`);
  } catch (e) { record("216F", "planning provider wiring", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216G — architecture provider wiring
  try {
    const gateway = new AIProviderGateway({
      providers: [new TestProvider(["success"], {
        systemOverview: "x",
        components: [{ id: "a", name: "A", responsibility: "r", dependsOn: [] }],
        interfaces: [], dataModel: ["x"], runtimeModel: ["x"], securityModel: ["x"],
        deploymentModel: ["x"], observabilityModel: ["x"],
        failureHandling: "x", technologyDecisions: ["x"], constraints: ["x"],
        verificationStrategy: ["x"],
      })],
    });
    const arch = new AIArchitectureProvider(gateway, "test-provider");
    const ctx = {
      runId: "run-G",
      request: { id: "req-G", runId: "run-G", requestText: "build x",
        requestHash: "0".repeat(64), createdBy: null, metadata: null, createdAt: Date.now() },
      validatedPlan: {
        planId: "plan-G", runId: "run-G", requestId: "req-G", version: 1,
        objective: "x", scope: "x",
        requirements: [{ id: "R1", text: "r" }],
        constraints: [{ id: "C1", text: "c" }],
        assumptions: [], acceptanceCriteria: ["ok"],
        plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
        dependencies: [], risks: [], verificationStrategy: ["unit"],
        status: "VALID", contentHash: "0".repeat(64), createdBy: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      },
    };
    const r = await arch.architect(ctx as never);
    ok(r.ok === true, `architect() failed`);
    if (r.ok) ok(r.architecture.systemOverview === "x", `overview=${r.architecture.systemOverview}`);
    record("216G", "architecture provider wiring", "PASS",
      `AIArchitectureProvider over gateway succeeded (test double)`);
  } catch (e) { record("216G", "architecture provider wiring", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216H — provider request normalization (AIProviderRequest shape round-trip)
  try {
    const provider = new TestProvider(["success"], { ok: true });
    const gateway = new AIProviderGateway({ providers: [provider] });
    const req = {
      requestId: rid("req-H-"),
      providerId: "test-provider",
      model: "test-model",
      systemPrompt: "sys",
      userPrompt: "user",
      responseFormat: "json_object" as const,
      timeoutMs: 5000,
      metadata: { test: true },
    };
    const r = await gateway.invoke(req);
    ok(r.ok === true, `invoke failed`);
    if (r.ok) {
      ok(r.response.requestId === req.requestId, `requestId mismatch`);
      ok(r.response.providerId === "test-provider", `providerId=${r.response.providerId}`);
      ok(r.response.model === "test-model", `model=${r.response.model}`);
      ok(typeof r.response.latencyMs === "number", `latencyMs missing`);
    }
    record("216H", "provider request normalization", "PASS",
      `request+response shaped correctly through gateway`);
  } catch (e) { record("216H", "provider request normalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216I — provider response normalization (structuredOutput echoed)
  try {
    const payload = { hello: "world", nested: { n: 1 } };
    const provider = new TestProvider(["success"], payload);
    const gateway = new AIProviderGateway({ providers: [provider] });
    const r = await gateway.invoke({
      requestId: rid("req-I-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 5000,
    });
    ok(r.ok === true, `invoke failed`);
    if (r.ok) {
      ok(typeof r.response.content === "string" && r.response.content.length > 0, "content empty");
      ok(r.response.structuredOutput !== null, "structuredOutput null");
      ok(JSON.stringify(r.response.structuredOutput) === JSON.stringify(payload), "structuredOutput mismatch");
    }
    record("216I", "provider response normalization", "PASS",
      `content + structuredOutput preserved through gateway`);
  } catch (e) { record("216I", "provider response normalization", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216J — planning structured-output validation (invalid stage cycle rejected)
  try {
    // Produce a plan whose stages form a cycle; AIPlanningProvider returns it
    // raw, then validateEngineeringPlan must reject.
    const { validateEngineeringPlan, computePlanContentHash } = await import("../src/core/engineering-plan-validator");
    const base: any = {
      planId: "plan-J", runId: "r", requestId: "q", version: 1,
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [
        { id: "S1", name: "A", dependsOn: ["S2"] },
        { id: "S2", name: "B", dependsOn: ["S1"] },
      ],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
      status: "VALIDATING",
    };
    const { contentHash: _x, ...hx } = base;
    base.contentHash = computePlanContentHash(hx as any);
    const v = validateEngineeringPlan(base);
    ok(!v.ok, `cycle should be rejected`);
    ok(v.errors.includes("STAGE_CYCLE_DETECTED"), `errors=${v.errors.join(",")}`);
    record("216J", "planning structured-output validation", "PASS",
      `cycle detected via validateEngineeringPlan`);
  } catch (e) { record("216J", "planning structured-output validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216K — architecture structured-output validation (empty components rejected)
  try {
    const { validateArchitectureSpecification, computePlanContentHash, computeArchitectureContentHash } = await import("../src/core/engineering-plan-validator");
    const planBase: any = {
      planId: "plan-K", runId: "r", requestId: "q", version: 1,
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
      status: "VALID",
    };
    const { contentHash: _x, ...hx } = planBase;
    planBase.contentHash = computePlanContentHash(hx as any);
    const archBase: any = {
      architectureId: "arch-K", runId: "r", planId: "plan-K", version: 1,
      systemOverview: "x", components: [], interfaces: [],
      dataModel: ["x"], runtimeModel: ["x"], securityModel: ["x"],
      deploymentModel: ["x"], observabilityModel: ["x"],
      failureHandling: "x", technologyDecisions: ["x"], constraints: ["x"],
      verificationStrategy: ["x"], status: "VALIDATING",
    };
    const { contentHash: _y, ...hy } = archBase;
    archBase.contentHash = computeArchitectureContentHash(hy as any);
    const v = validateArchitectureSpecification(archBase, planBase as any);
    ok(!v.ok, `empty components should be rejected`);
    ok(v.errors.includes("COMPONENTS_EMPTY"), `errors=${v.errors.join(",")}`);
    record("216K", "architecture structured-output validation", "PASS",
      `empty components rejected via validateArchitectureSpecification`);
  } catch (e) { record("216K", "architecture structured-output validation", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216L — invalid provider response rejection (no content)
  try {
    const gateway = new AIProviderGateway({ providers: [new TestProvider(["no-content"])] });
    const r = await gateway.invoke({
      requestId: rid("req-L-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 5000,
    });
    // TestProvider double returns empty content which the gateway currently
    // accepts at the gateway layer. The planning provider checks for content
    // and must reject.
    const planning = new AIPlanningProvider(gateway, "test-provider");
    const ctx = {
      runId: "run-L",
      request: { id: "req-L", runId: "run-L", requestText: "x",
        requestHash: "0".repeat(64), createdBy: null, metadata: null, createdAt: Date.now() },
    };
    const pr = await planning.plan(ctx as never);
    ok(pr.ok === false, `empty content should not produce an ok plan`);
    record("216L", "invalid provider response rejection", "PASS",
      `empty content rejected at planning provider boundary: ${!pr.ok ? pr.reason : "?"}`);
  } catch (e) { record("216L", "invalid provider response rejection", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216M — provider timeout handling
  try {
    const gateway = new AIProviderGateway({ providers: [new TestProvider(["timeout"])] });
    const r = await gateway.invoke({
      requestId: rid("req-M-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 100,
    });
    ok(r.ok === false, `timeout should produce error`);
    if (!r.ok) {
      ok(r.error.errorClass === "TIMEOUT", `errorClass=${r.error.errorClass}`);
      ok(r.error.retryable === true, `retryable should be true for TIMEOUT`);
    }
    record("216M", "provider timeout handling", "PASS",
      `timeout classified correctly: ${!r.ok ? r.error.errorClass : "?"}`);
  } catch (e) { record("216M", "provider timeout handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216N — provider transient failure handling (connection then success)
  try {
    const provider = new TestProvider(["connection-once-then-success"], { ok: true });
    const gateway = new AIProviderGateway({ providers: [provider] });
    const r = await gateway.invoke({
      requestId: rid("req-N-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 5000,
    });
    ok(r.ok === true, `should succeed after retry`);
    if (r.ok) ok(r.attempts === 2, `attempts=${r.attempts}`);
    record("216N", "provider transient failure handling", "PASS",
      `transient CONNECTION failure retried and succeeded; attempts=${(r as any).attempts}`);
  } catch (e) { record("216N", "provider transient failure handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216O — bounded retry behavior (exhausts retries and stops)
  try {
    const provider = new TestProvider(["timeout"]);
    provider.configuration.maxRetries = 2;
    const gateway = new AIProviderGateway({ providers: [provider] });
    const r = await gateway.invoke({
      requestId: rid("req-O-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 100,
    });
    ok(r.ok === false, `should fail after bounded retries`);
    if (!r.ok) ok(r.attempts <= 3, `attempts=${r.attempts} (should be capped at 1+maxRetries=3)`);
    ok(provider.invocations <= 3, `provider.invocations=${provider.invocations} exceeds cap`);
    record("216O", "bounded retry behavior", "PASS",
      `attempts capped at ${(r as any).attempts} (maxRetries=2)`);
  } catch (e) { record("216O", "bounded retry behavior", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216P — non-retryable failure handling (AUTH not retried)
  try {
    const provider = new TestProvider(["auth-failure"]);
    const gateway = new AIProviderGateway({ providers: [provider] });
    const r = await gateway.invoke({
      requestId: rid("req-P-"), providerId: "test-provider", model: "m",
      systemPrompt: "s", userPrompt: "u", responseFormat: "json_object", timeoutMs: 5000,
    });
    ok(r.ok === false, `auth failure should fail`);
    if (!r.ok) ok(r.error.errorClass === "AUTH", `errorClass=${r.error.errorClass}`);
    ok(provider.invocations === 1, `auth should not be retried; invocations=${provider.invocations}`);
    record("216P", "non-retryable failure handling", "PASS",
      `AUTH not retried; invocations=${provider.invocations}`);
  } catch (e) { record("216P", "non-retryable failure handling", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216Q — planning provider failure -> FAILED
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 Q " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-Q",
    });
    const gateway = new AIProviderGateway({ providers: [new TestProvider(["timeout"])] });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(gateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "plan Q" });
    const out = await orchestrator.runPlanning(run.run.id, req.request.id);
    ok(out.status === "FAILED", `status=${out.status}`);
    ok(out.reason.startsWith("PROVIDER_"), `reason=${out.reason}`);
    record("216Q", "planning provider failure -> FAILED", "PASS",
      `status=${out.status} reason=${out.reason}`);
  } catch (e) { record("216Q", "planning provider failure -> FAILED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216R — architecture provider failure -> FAILED
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 R " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-R",
    });
    const planningGateway = new AIProviderGateway({ providers: [new TestProvider(["success"], {
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
    })] });
    const archGateway = new AIProviderGateway({ providers: [new TestProvider(["timeout"])] });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(planningGateway, "test-provider"),
      new AIArchitectureProvider(archGateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "arch R" });
    const planOut = await orchestrator.runPlanning(run.run.id, req.request.id);
    ok(planOut.status === "SUCCEEDED" && planOut.plan, `planning failed: ${planOut.reason}`);
    const archOut = await orchestrator.runArchitecture(run.run.id, planOut.plan!.planId);
    ok(archOut.status === "FAILED", `status=${archOut.status}`);
    record("216R", "architecture provider failure -> FAILED", "PASS",
      `status=${archOut.status} reason=${archOut.reason}`);
  } catch (e) { record("216R", "architecture provider failure -> FAILED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216S — unavailable provider -> BLOCKED
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 S " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-S",
    });
    // Gateway with no registered provider at all.
    const gateway = new AIProviderGateway({ providers: [] });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(gateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "plan S" });
    const out = await orchestrator.runPlanning(run.run.id, req.request.id);
    // Phase 216: an unconfigured/unavailable provider was never invoked, so
    // the correct terminal state is BLOCKED, not FAILED.
    ok(out.status === "BLOCKED", `expected BLOCKED, got ${out.status}`);
    ok(out.reason === "PROVIDER_NOT_CONFIGURED",
       `expected reason=PROVIDER_NOT_CONFIGURED, got ${out.reason}`);
    const blockedEvts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type=$2",
      [run.run.id, "engineering_planning.blocked"]);
    ok(blockedEvts.rows.length >= 1, "engineering_planning.blocked event missing");
    const failedEvts = await pgExec(
      "SELECT event_type FROM engineering_run_events WHERE run_id=$1 AND event_type=$2",
      [run.run.id, "engineering_planning.failed"]);
    ok(failedEvts.rows.length === 0, "engineering_planning.failed should not be emitted for BLOCKED");
    record("216S", "unavailable provider -> BLOCKED", "PASS",
      `status=${out.status} reason=${out.reason}`);
  } catch (e) { record("216S", "unavailable provider -> BLOCKED", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216T — real-provider planning path (BLOCKED if no live provider)
  try {
    const envCfg = openAICompatibleConfigFromEnv(process.env);
    if (!envCfg.enabled) {
      record("216T", "real-provider planning path", "BLOCKED",
        "no real provider configured (NEXUS_AI_ENABLED=true + NEXUS_AI_MODEL + API key env var required)");
    } else {
      const provider = new OpenAICompatibleProvider(envCfg);
      const probe = await provider.probe();
      if (probe.status !== "AVAILABLE") {
        record("216T", "real-provider planning path", "BLOCKED",
          `probe=${probe.status} reason=${probe.reason}`);
      } else {
        const gateway = new AIProviderGateway({ providers: [provider] });
        const planning = new AIPlanningProvider(gateway, provider.providerId);
        const run = await runService.createEngineeringRun({
          objective: "Phase 216 T " + prefix,
          repository: "github.com/example/p216",
          sourceRevision: "sha-T",
        });
        const orchestrator = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, planning);
        const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "plan a small REST service" });
        const out = await orchestrator.runPlanning(run.run.id, req.request.id);
        if (out.status === "SUCCEEDED") {
          record("216T", "real-provider planning path", "PASS", `plan=${out.plan!.planId}`);
        } else {
          record("216T", "real-provider planning path", "FAIL", `status=${out.status} reason=${out.reason}`);
        }
      }
    }
  } catch (e) { record("216T", "real-provider planning path", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216U — real-provider architecture path (BLOCKED if no live provider)
  try {
    const envCfg = openAICompatibleConfigFromEnv(process.env);
    if (!envCfg.enabled) {
      record("216U", "real-provider architecture path", "BLOCKED",
        "no real provider configured");
    } else {
      const provider = new OpenAICompatibleProvider(envCfg);
      const probe = await provider.probe();
      if (probe.status !== "AVAILABLE") {
        record("216U", "real-provider architecture path", "BLOCKED",
          `probe=${probe.status} reason=${probe.reason}`);
      } else {
        // Full path with real provider: plan then architecture.
        const gateway = new AIProviderGateway({ providers: [provider] });
        const planning = new AIPlanningProvider(gateway, provider.providerId);
        const architecture = new AIArchitectureProvider(gateway, provider.providerId);
        const run = await runService.createEngineeringRun({
          objective: "Phase 216 U " + prefix,
          repository: "github.com/example/p216",
          sourceRevision: "sha-U",
        });
        const orchestrator = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, planning, architecture);
        const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "small REST service" });
        const planOut = await orchestrator.runPlanning(run.run.id, req.request.id);
        if (planOut.status !== "SUCCEEDED" || !planOut.plan) {
          record("216U", "real-provider architecture path", "FAIL",
            `planning failed: ${planOut.reason}`);
        } else {
          const archOut = await orchestrator.runArchitecture(run.run.id, planOut.plan.planId);
          if (archOut.status === "SUCCEEDED") {
            record("216U", "real-provider architecture path", "PASS",
              `arch=${archOut.architecture!.architectureId}`);
          } else {
            record("216U", "real-provider architecture path", "FAIL",
              `status=${archOut.status} reason=${archOut.reason}`);
          }
        }
      }
    }
  } catch (e) { record("216U", "real-provider architecture path", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216V — artifact persistence with checksum (via test double)
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 V " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-V",
    });
    const gateway = new AIProviderGateway({ providers: [new TestProvider(["success"], {
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
    })] });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(gateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "artifact V" });
    const out = await orchestrator.runPlanning(run.run.id, req.request.id);
    ok(out.status === "SUCCEEDED" && out.plan, `planning failed: ${out.reason}`);
    const artifactRow = await pgExec(
      "SELECT artifact_id, checksum, type FROM execution_artifacts WHERE artifact_id=$1",
      ["art-plan-" + out.plan!.planId]);
    ok(artifactRow.rows.length === 1, "plan artifact missing");
    ok(artifactRow.rows[0].type === "ENGINEERING_PLAN", `type=${artifactRow.rows[0].type}`);
    const hex64 = /^[0-9a-f]{64}$/;
    ok(hex64.test(artifactRow.rows[0].checksum),
       `artifact checksum not 64-hex: ${artifactRow.rows[0].checksum}`);
    ok(hex64.test(out.plan!.contentHash),
       `plan contentHash not 64-hex: ${out.plan!.contentHash}`);
    record("216V", "artifact persistence with checksum", "PASS",
      `artifact.checksum and plan.contentHash are valid 64-hex digests`);
  } catch (e) { record("216V", "artifact persistence with checksum", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216W — lifecycle event persistence (ai.provider.* and engineering_plan.* events reach journal)
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 W " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-W",
    });
    // Capture AI gateway events into engineering_run_events via a tiny sink.
    const sinkEvents: string[] = [];
    const sink = {
      onEvent: (e: any) => { sinkEvents.push(e.type); },
    };
    const gateway = new AIProviderGateway({
      providers: [new TestProvider(["success"], {
        objective: "x", scope: "x",
        requirements: [{ id: "R1", text: "r" }],
        constraints: [{ id: "C1", text: "c" }],
        assumptions: [], acceptanceCriteria: ["ok"],
        plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
        dependencies: [], risks: [], verificationStrategy: ["unit"],
      })],
      onEvent: sink.onEvent,
    });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(gateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "event W" });
    await orchestrator.runPlanning(run.run.id, req.request.id);
    ok(sinkEvents.includes("ai.provider.requested"), "ai.provider.requested missing");
    ok(sinkEvents.includes("ai.provider.completed"), "ai.provider.completed missing");
    const evts = await pgExec(
      "SELECT DISTINCT event_type FROM engineering_run_events WHERE run_id=$1",
      [run.run.id]);
    const types = new Set<string>(evts.rows.map((r: any) => r.event_type));
    ok(types.has("engineering_plan.validated"), "engineering_plan.validated missing");
    record("216W", "lifecycle event persistence", "PASS",
      `ai events=${sinkEvents.length} engineering events=${types.size}`);
  } catch (e) { record("216W", "lifecycle event persistence", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216X — duplicate execution/idempotency (second runPlanning reuses existing)
  try {
    const run = await runService.createEngineeringRun({
      objective: "Phase 216 X " + prefix,
      repository: "github.com/example/p216",
      sourceRevision: "sha-X",
    });
    const provider = new TestProvider(["success"], {
      objective: "x", scope: "x",
      requirements: [{ id: "R1", text: "r" }],
      constraints: [{ id: "C1", text: "c" }],
      assumptions: [], acceptanceCriteria: ["ok"],
      plannedStages: [{ id: "S1", name: "A", dependsOn: [] }],
      dependencies: [], risks: [], verificationStrategy: ["unit"],
    });
    const gateway = new AIProviderGateway({ providers: [provider] });
    const orchestrator = new EngineeringPlanningOrchestrator(
      dbUrl, store as never, artifacts,
      new AIPlanningProvider(gateway, "test-provider"),
    );
    const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "idem X" });
    const a = await orchestrator.runPlanning(run.run.id, req.request.id);
    const invocationsAfterFirst = provider.invocations;
    const b = await orchestrator.runPlanning(run.run.id, req.request.id);
    ok(a.status === "SUCCEEDED" && b.status === "SUCCEEDED", `a=${a.status} b=${b.status}`);
    ok(a.plan!.planId === b.plan!.planId, "plan ids differ");
    ok(provider.invocations === invocationsAfterFirst,
       `provider invoked again: ${invocationsAfterFirst} → ${provider.invocations}`);
    record("216X", "duplicate execution/idempotency", "PASS",
      `second runPlanning reused plan without provider call`);
  } catch (e) { record("216X", "duplicate execution/idempotency", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216Y — secret-redaction/security boundary
  try {
    const samples = [
      "Authorization: Bearer sk-abcdef1234567890ABCDEFG",
      "api_key=sk-verysecretvalue1234567890",
      "password=hunter2",
      'access_token="tok_abcdef123456"',
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----",
    ];
    for (const s of samples) {
      const r = redactSecrets(s);
      ok(r.includes("[REDACTED]") || r.includes("[REDACTED PRIVATE KEY]"),
         `redaction missed: ${s.slice(0, 40)}`);
      ok(!/sk-abcdef1234567890ABCDEFG/.test(r), "bearer key leaked");
      ok(!/sk-verysecretvalue1234567890/.test(r), "api_key value leaked");
      ok(!/hunter2/.test(r), "password leaked");
      ok(!/tok_abcdef123456/.test(r), "access_token leaked");
    }
    // Deep redaction on structured payload.
    const structured = redactDeep({ token: "secret-token", nested: { api_key: "secret-key" } }) as any;
    ok(structured.token === "[REDACTED]", "deep token not redacted");
    ok(structured.nested.api_key === "[REDACTED]", "deep api_key not redacted");
    // Bounded truncation.
    const big = "x".repeat(10000);
    const small = bounded(big, 100);
    ok(Buffer.byteLength(small, "utf8") <= 100, `bounded did not cap: ${Buffer.byteLength(small, "utf8")}`);
    record("216Y", "secret-redaction/security boundary", "PASS",
      `redaction + deep redaction + bounded truncation all hold`);
  } catch (e) { record("216Y", "secret-redaction/security boundary", "FAIL", e instanceof Error ? e.message : String(e)); }

  // 216Z — end-to-end real provider planning -> architecture
  try {
    const envCfg = openAICompatibleConfigFromEnv(process.env);
    if (!envCfg.enabled) {
      record("216Z", "end-to-end real provider planning -> architecture", "BLOCKED",
        "no real provider configured");
    } else {
      const provider = new OpenAICompatibleProvider(envCfg);
      const probe = await provider.probe();
      if (probe.status !== "AVAILABLE") {
        record("216Z", "end-to-end real provider planning -> architecture", "BLOCKED",
          `probe=${probe.status} reason=${probe.reason}`);
      } else {
        const gateway = new AIProviderGateway({ providers: [provider] });
        const planning = new AIPlanningProvider(gateway, provider.providerId);
        const architecture = new AIArchitectureProvider(gateway, provider.providerId);
        const run = await runService.createEngineeringRun({
          objective: "Phase 216 Z " + prefix,
          repository: "github.com/example/p216",
          sourceRevision: "sha-Z",
        });
        const orchestrator = new EngineeringPlanningOrchestrator(dbUrl, store as never, artifacts, planning, architecture);
        const req = await orchestrator.submitRequest({ runId: run.run.id, requestText: "small REST service with health endpoint" });
        const planOut = await orchestrator.runPlanning(run.run.id, req.request.id);
        if (planOut.status !== "SUCCEEDED" || !planOut.plan) {
          record("216Z", "end-to-end real provider planning -> architecture", "FAIL",
            `planning failed: ${planOut.reason}`);
        } else {
          const archOut = await orchestrator.runArchitecture(run.run.id, planOut.plan.planId);
          if (archOut.status === "SUCCEEDED") {
            record("216Z", "end-to-end real provider planning -> architecture", "PASS",
              `plan=${planOut.plan.planId} arch=${archOut.architecture!.architectureId}`);
          } else {
            record("216Z", "end-to-end real provider planning -> architecture", "FAIL",
              `architecture failed: ${archOut.reason}`);
          }
        }
      }
    }
  } catch (e) { record("216Z", "end-to-end real provider planning -> architecture", "FAIL", e instanceof Error ? e.message : String(e)); }

  return finish(kernel, prefix);
}

async function finish(kernel: NexusKernel, prefix: string): Promise<void> {
  try { await kernel.stopDistributedScheduler(); } catch { /* ignore */ }
  try { await kernel.shutdown({ finalRecoveryPass: false }); } catch { /* ignore */ }
  try { await pgCleanup(prefix); } catch (e) { console.log("216 cleanup warning:", e); }
  const counts = rows.reduce<Record<Result, number>>(
    (acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; },
    { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT EXECUTED": 0 },
  );
  console.log("\n===== Phase 216 summary =====");
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
