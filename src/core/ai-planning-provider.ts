// src/core/ai-planning-provider.ts
// Phase 216: concrete PlanningProvider and ArchitectureProvider built on the
// provider-neutral AI gateway. These adapters:
//   - build deterministic prompts for the Phase 215 domain contracts
//   - require structured JSON output from the provider
//   - never trust provider output — the orchestrator validates it
//   - never include secrets in prompts
//
// When the gateway is not configured, plan() and architect() return
// { ok: false, reason: "PROVIDER_NOT_CONFIGURED" } and the orchestrator
// persists BLOCKED, exactly as it did in Phase 215 without a provider.

import { randomUUID } from "node:crypto";
import {
  type PlanningProvider,
  type ArchitectureProvider,
  type ProviderContext,
  type ArchitectureProviderContext,
  type PlanProviderResult,
  type ArchitectureProviderResult,
  type ProviderError,
} from "./engineering-planning-contracts";
import { AIProviderGateway } from "./ai-provider-gateway";
import { bounded } from "./ai-provider-redaction";

const MAX_PROMPT_CHARS = 24_000;

/** JSON schema shape descriptions that go into the prompt (not enforced by provider). */
const PLAN_SHAPE = {
  objective: "string",
  scope: "string",
  requirements: [{ id: "string", text: "string" }],
  constraints: [{ id: "string", text: "string" }],
  assumptions: ["string"],
  acceptanceCriteria: ["string"],
  plannedStages: [{ id: "string", name: "string", dependsOn: ["string"] }],
  dependencies: [{ from: "string", to: "string" }],
  risks: [{ id: "string", description: "string", severity: "LOW|MEDIUM|HIGH|CRITICAL" }],
  verificationStrategy: ["string"],
};

const ARCH_SHAPE = {
  systemOverview: "string",
  components: [{ id: "string", name: "string", responsibility: "string", dependsOn: ["string"] }],
  interfaces: [{ id: "string", fromComponent: "string", toComponent: "string", description: "string" }],
  dataModel: ["string"],
  runtimeModel: ["string"],
  securityModel: ["string"],
  deploymentModel: ["string"],
  observabilityModel: ["string"],
  failureHandling: "string",
  technologyDecisions: ["string"],
  constraints: ["string"],
  verificationStrategy: ["string"],
};

function planSystemPrompt(): string {
  return [
    "You are an engineering planning assistant for the NEXUS platform.",
    "You produce a PLAN only. You do not execute anything and you do not",
    "claim that anything has been tested, deployed, or verified.",
    "Never invent evidence of execution. Never include credentials, tokens,",
    "API keys, passwords, or environment secrets in your output.",
    "Respond with a single JSON object matching this shape:",
    JSON.stringify(PLAN_SHAPE, null, 2),
  ].join("\n");
}

function architectureSystemPrompt(): string {
  return [
    "You are an engineering architecture assistant for the NEXUS platform.",
    "You produce a SPECIFICATION only. You do not execute anything and you do",
    "not claim that infrastructure was deployed, builds succeeded, tests",
    "passed, or security reviews completed.",
    "Never include credentials, tokens, API keys, passwords, or environment",
    "secrets in your output.",
    "Respond with a single JSON object matching this shape:",
    JSON.stringify(ARCH_SHAPE, null, 2),
  ].join("\n");
}

function planUserPrompt(ctx: ProviderContext): string {
  const { runId, request } = ctx;
  const lines = [
    `Run ID: ${runId}`,
    `Repository: (see request)`,
    `Engineering objective: ${request.requestText}`,
    "",
    "Produce an EngineeringPlan for this objective.",
    "The plan must include concrete plannedStages with unique ids and valid",
    "dependsOn edges (no cycles), acceptance criteria, and a verification",
    "strategy. Requirements and constraints must each be objects with id+text.",
    "",
    "Return only the JSON object.",
  ];
  return bounded(lines.join("\n"), MAX_PROMPT_CHARS);
}

function architectureUserPrompt(ctx: ArchitectureProviderContext): string {
  const { runId, validatedPlan } = ctx;
  const lines = [
    `Run ID: ${runId}`,
    `Plan version: ${validatedPlan.version}`,
    `Plan objective: ${validatedPlan.objective}`,
    "",
    "Requirements:",
    ...validatedPlan.requirements.map((r) => `- ${r.id}: ${r.text}`),
    "",
    "Constraints:",
    ...validatedPlan.constraints.map((c) => `- ${c.id}: ${c.text}`),
    "",
    "Produce an ArchitectureSpecification for this validated plan.",
    "Components must have unique ids; interfaces must reference existing",
    "components; component graph must be acyclic.",
    "",
    "Return only the JSON object.",
  ];
  return bounded(lines.join("\n"), MAX_PROMPT_CHARS);
}

/**
 * Deterministic callers can construct one of these with a gateway. The
 * gateway is provider-neutral; the adapter name in the gateway is the only
 * vendor detail. If the gateway is not configured, invoke() returns
 * { ok: false, error: { errorClass: "NOT_CONFIGURED" } }.
 */
export class AIPlanningProvider implements PlanningProvider {
  readonly providerId = "ai-planning";
  constructor(
    private readonly gateway: AIProviderGateway,
    private readonly targetProviderId: string,
  ) {}

  async plan(ctx: ProviderContext): Promise<PlanProviderResult | ProviderError> {
    const requestId = randomUUID();
    const result = await this.gateway.invoke({
      requestId,
      providerId: this.targetProviderId,
      model: "",
      systemPrompt: planSystemPrompt(),
      userPrompt: planUserPrompt(ctx),
      responseFormat: "json_object",
      timeoutMs: 60_000,
      metadata: { runId: ctx.runId, phase: "PLANNING" },
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: "PROVIDER_" + result.error.errorClass,
        detail: result.error.message,
      };
    }
    const content = result.response.structuredOutput;
    if (!content || typeof content !== "object") {
      return { ok: false, reason: "INVALID_RESPONSE", detail: "provider returned no structured output" };
    }
    const c = content as Record<string, unknown>;
    return {
      ok: true,
      plan: {
        planId: "plan-" + randomUUID(),
        runId: ctx.runId,
        requestId: ctx.request.id,
        version: 1,
        objective: typeof c.objective === "string" ? c.objective : ctx.request.requestText,
        scope: typeof c.scope === "string" ? c.scope : "",
        requirements: Array.isArray(c.requirements) ? (c.requirements as any) : [],
        constraints: Array.isArray(c.constraints) ? (c.constraints as any) : [],
        assumptions: Array.isArray(c.assumptions) ? (c.assumptions as string[]) : [],
        acceptanceCriteria: Array.isArray(c.acceptanceCriteria) ? (c.acceptanceCriteria as string[]) : [],
        plannedStages: Array.isArray(c.plannedStages) ? (c.plannedStages as any) : [],
        dependencies: Array.isArray(c.dependencies) ? (c.dependencies as any) : [],
        risks: Array.isArray(c.risks) ? (c.risks as any) : [],
        verificationStrategy: Array.isArray(c.verificationStrategy) ? (c.verificationStrategy as string[]) : [],
      },
    };
  }
}

export class AIArchitectureProvider implements ArchitectureProvider {
  readonly providerId = "ai-architecture";
  constructor(
    private readonly gateway: AIProviderGateway,
    private readonly targetProviderId: string,
  ) {}

  async architect(ctx: ArchitectureProviderContext): Promise<ArchitectureProviderResult | ProviderError> {
    const requestId = randomUUID();
    const result = await this.gateway.invoke({
      requestId,
      providerId: this.targetProviderId,
      model: "",
      systemPrompt: architectureSystemPrompt(),
      userPrompt: architectureUserPrompt(ctx),
      responseFormat: "json_object",
      timeoutMs: 60_000,
      metadata: { runId: ctx.runId, phase: "ARCHITECTURE" },
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: "PROVIDER_" + result.error.errorClass,
        detail: result.error.message,
      };
    }
    const content = result.response.structuredOutput;
    if (!content || typeof content !== "object") {
      return { ok: false, reason: "INVALID_RESPONSE", detail: "provider returned no structured output" };
    }
    const c = content as Record<string, unknown>;
    return {
      ok: true,
      architecture: {
        architectureId: "arch-" + randomUUID(),
        runId: ctx.runId,
        planId: ctx.validatedPlan.planId,
        version: ctx.validatedPlan.version,
        systemOverview: typeof c.systemOverview === "string" ? c.systemOverview : "",
        components: Array.isArray(c.components) ? (c.components as any) : [],
        interfaces: Array.isArray(c.interfaces) ? (c.interfaces as any) : [],
        dataModel: Array.isArray(c.dataModel) ? (c.dataModel as string[]) : [],
        runtimeModel: Array.isArray(c.runtimeModel) ? (c.runtimeModel as string[]) : [],
        securityModel: Array.isArray(c.securityModel) ? (c.securityModel as string[]) : [],
        deploymentModel: Array.isArray(c.deploymentModel) ? (c.deploymentModel as string[]) : [],
        observabilityModel: Array.isArray(c.observabilityModel) ? (c.observabilityModel as string[]) : [],
        failureHandling: typeof c.failureHandling === "string" ? c.failureHandling : "",
        technologyDecisions: Array.isArray(c.technologyDecisions) ? (c.technologyDecisions as string[]) : [],
        constraints: Array.isArray(c.constraints) ? (c.constraints as string[]) : [],
        verificationStrategy: Array.isArray(c.verificationStrategy) ? (c.verificationStrategy as string[]) : [],
      },
    };
  }
}
