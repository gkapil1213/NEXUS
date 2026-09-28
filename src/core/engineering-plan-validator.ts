// src/core/engineering-plan-validator.ts
// Phase 215: deterministic validation for engineering plans and architecture
// specifications. Pure functions. No I/O, no side effects.
//
// Reuses detectCycle from worker-recovery-dependency.ts (the same primitive
// Phase 201/203 use for stage dependency DAGs).

import { createHash } from "node:crypto";
import { detectCycle, type DependencyGraph } from "./worker-recovery-dependency";
import type {
  EngineeringPlan,
  ArchitectureSpecification,
} from "./engineering-planning-contracts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Deterministic canonical JSON — keys sorted, no undefined. */
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return "null";
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computePlanContentHash(
  plan: Omit<EngineeringPlan, "contentHash">,
): string {
  return sha256(canonicalize({
    runId: plan.runId, requestId: plan.requestId, version: plan.version,
    objective: plan.objective, scope: plan.scope,
    requirements: plan.requirements, constraints: plan.constraints,
    assumptions: plan.assumptions, acceptanceCriteria: plan.acceptanceCriteria,
    plannedStages: plan.plannedStages, dependencies: plan.dependencies,
    risks: plan.risks, verificationStrategy: plan.verificationStrategy,
  }));
}

export function computeArchitectureContentHash(
  arch: Omit<ArchitectureSpecification, "contentHash">,
): string {
  return sha256(canonicalize({
    runId: arch.runId, planId: arch.planId, version: arch.version,
    systemOverview: arch.systemOverview, components: arch.components,
    interfaces: arch.interfaces, dataModel: arch.dataModel,
    runtimeModel: arch.runtimeModel, securityModel: arch.securityModel,
    deploymentModel: arch.deploymentModel, observabilityModel: arch.observabilityModel,
    failureHandling: arch.failureHandling, technologyDecisions: arch.technologyDecisions,
    constraints: arch.constraints, verificationStrategy: arch.verificationStrategy,
  }));
}

// ---------------- Plan validation ----------------

export function validateEngineeringPlan(plan: EngineeringPlan): ValidationResult {
  const errors: string[] = [];

  if (!plan.objective || !plan.objective.trim()) errors.push("OBJECTIVE_EMPTY");
  if (!Array.isArray(plan.requirements)) errors.push("REQUIREMENTS_NOT_ARRAY");
  else if (plan.requirements.some((r) => !r.id || !r.text)) errors.push("REQUIREMENT_MISSING_FIELDS");
  if (!Array.isArray(plan.constraints)) errors.push("CONSTRAINTS_NOT_ARRAY");
  else if (plan.constraints.some((c) => !c.id || !c.text)) errors.push("CONSTRAINT_MISSING_FIELDS");
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length === 0) {
    errors.push("ACCEPTANCE_CRITERIA_EMPTY");
  }
  if (!Array.isArray(plan.plannedStages) || plan.plannedStages.length === 0) {
    errors.push("PLANNED_STAGES_EMPTY");
  } else {
    const stageIds = new Set<string>();
    for (const s of plan.plannedStages) {
      if (!s.id) { errors.push("STAGE_MISSING_ID"); continue; }
      if (stageIds.has(s.id)) { errors.push("STAGE_ID_DUPLICATE:" + s.id); continue; }
      stageIds.add(s.id);
      if (!Array.isArray(s.dependsOn)) { errors.push("STAGE_DEPS_NOT_ARRAY:" + s.id); continue; }
      for (const dep of s.dependsOn) {
        if (!stageIds.has(dep) && !plan.plannedStages.some((x) => x.id === dep)) {
          errors.push("STAGE_DEP_UNKNOWN:" + s.id + "->" + dep);
        }
      }
    }
    // Cycle detection over stage graph.
    const edges: Record<string, string[]> = {};
    for (const s of plan.plannedStages) edges[s.id] = [...(s.dependsOn ?? [])];
    const graph: DependencyGraph = { nodes: plan.plannedStages.map((s) => s.id), edges };
    if (detectCycle(graph)) errors.push("STAGE_CYCLE_DETECTED");
  }

  // Recompute the content hash and compare.
  if (plan.contentHash) {
    const { contentHash: _omit, ...rest } = plan;
    const recomputed = computePlanContentHash(rest);
    if (recomputed !== plan.contentHash) errors.push("CONTENT_HASH_MISMATCH");
  } else {
    errors.push("CONTENT_HASH_MISSING");
  }

  return { ok: errors.length === 0, errors };
}

// ---------------- Architecture validation ----------------

export function validateArchitectureSpecification(
  arch: ArchitectureSpecification,
  plan: EngineeringPlan | null,
): ValidationResult {
  const errors: string[] = [];

  if (!plan) { errors.push("REFERENCED_PLAN_NOT_FOUND"); return { ok: false, errors }; }
  if (plan.status !== "VALID") errors.push("REFERENCED_PLAN_NOT_VALID");
  if (arch.planId !== plan.planId) errors.push("PLAN_ID_MISMATCH");
  if (arch.runId !== plan.runId) errors.push("RUN_ID_MISMATCH");
  if (arch.version !== plan.version) errors.push("VERSION_MISMATCH_WITH_PLAN");

  if (!arch.systemOverview || !arch.systemOverview.trim()) errors.push("SYSTEM_OVERVIEW_EMPTY");
  if (!Array.isArray(arch.components) || arch.components.length === 0) {
    errors.push("COMPONENTS_EMPTY");
  } else {
    const compIds = new Set<string>();
    for (const c of arch.components) {
      if (!c.id) { errors.push("COMPONENT_MISSING_ID"); continue; }
      if (compIds.has(c.id)) { errors.push("COMPONENT_ID_DUPLICATE:" + c.id); continue; }
      compIds.add(c.id);
      for (const dep of c.dependsOn ?? []) {
        if (!arch.components.some((x) => x.id === dep)) {
          errors.push("COMPONENT_DEP_UNKNOWN:" + c.id + "->" + dep);
        }
      }
    }
    // Cycle detection over component graph.
    const edges: Record<string, string[]> = {};
    for (const c of arch.components) edges[c.id] = [...(c.dependsOn ?? [])];
    const graph: DependencyGraph = { nodes: arch.components.map((c) => c.id), edges };
    if (detectCycle(graph)) errors.push("COMPONENT_CYCLE_DETECTED");

    // Interface references must be valid.
    if (Array.isArray(arch.interfaces)) {
      for (const iface of arch.interfaces) {
        if (!compIds.has(iface.fromComponent)) errors.push("IFACE_FROM_UNKNOWN:" + iface.id);
        if (!compIds.has(iface.toComponent)) errors.push("IFACE_TO_UNKNOWN:" + iface.id);
      }
    } else {
      errors.push("INTERFACES_NOT_ARRAY");
    }
  }

  if (!Array.isArray(arch.technologyDecisions)) errors.push("TECH_DECISIONS_NOT_ARRAY");
  if (!Array.isArray(arch.verificationStrategy) || arch.verificationStrategy.length === 0) {
    errors.push("VERIFICATION_STRATEGY_EMPTY");
  }

  if (arch.contentHash) {
    const { contentHash: _omit, ...rest } = arch;
    const recomputed = computeArchitectureContentHash(rest);
    if (recomputed !== arch.contentHash) errors.push("CONTENT_HASH_MISMATCH");
  } else {
    errors.push("CONTENT_HASH_MISSING");
  }

  return { ok: errors.length === 0, errors };
}
