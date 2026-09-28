// src/core/engineering-planning-contracts.ts
// Phase 215: provider-neutral planning and architecture contracts.
//
// These interfaces are the boundary between the engineering-run
// orchestration layer and whatever provider (AI, human, or future executor)
// actually produces a plan or an architecture. The orchestration layer
// depends only on these contracts — never on a specific commercial provider.

export interface EngineeringRequest {
  id: string;
  runId: string;
  requestText: string;
  requestHash: string;
  createdBy: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface PlanRequirement {
  id: string;
  text: string;
}

export interface PlanConstraint {
  id: string;
  text: string;
}

export interface PlannedStage {
  id: string;
  name: string;
  dependsOn: string[];
}

export interface PlanRisk {
  id: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export type EngineeringPlanStatus = "DRAFT" | "VALIDATING" | "VALID" | "INVALID" | "SUPERSEDED";

export interface EngineeringPlan {
  planId: string;
  runId: string;
  requestId: string;
  version: number;
  objective: string;
  scope: string;
  requirements: PlanRequirement[];
  constraints: PlanConstraint[];
  assumptions: string[];
  acceptanceCriteria: string[];
  plannedStages: PlannedStage[];
  dependencies: Array<{ from: string; to: string }>;
  risks: PlanRisk[];
  verificationStrategy: string[];
  status: EngineeringPlanStatus;
  contentHash: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArchitectureComponent {
  id: string;
  name: string;
  responsibility: string;
  dependsOn: string[];
}

export interface ArchitectureInterface {
  id: string;
  fromComponent: string;
  toComponent: string;
  description: string;
}

export type ArchitectureStatus = "DRAFT" | "VALIDATING" | "VALID" | "INVALID" | "SUPERSEDED";

export interface ArchitectureSpecification {
  architectureId: string;
  runId: string;
  planId: string;
  version: number;
  systemOverview: string;
  components: ArchitectureComponent[];
  interfaces: ArchitectureInterface[];
  dataModel: string[];
  runtimeModel: string[];
  securityModel: string[];
  deploymentModel: string[];
  observabilityModel: string[];
  failureHandling: string;
  technologyDecisions: string[];
  constraints: string[];
  verificationStrategy: string[];
  status: ArchitectureStatus;
  contentHash: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------- Provider contracts ----------------

export interface ProviderContext {
  runId: string;
  request: EngineeringRequest;
}

export interface PlanProviderResult {
  ok: true;
  plan: Omit<EngineeringPlan, "contentHash" | "createdAt" | "updatedAt" | "status" | "createdBy">;
}
export interface ProviderError {
  ok: false;
  reason: string;
  detail?: string;
}

/**
 * Provider-neutral. Implementations may wrap an LLM, a rules engine, or a
 * human editor. Phase 215 ships NO concrete production provider — that
 * wiring belongs to a later phase.
 */
export interface PlanningProvider {
  readonly providerId: string;
  plan(ctx: ProviderContext): Promise<PlanProviderResult | ProviderError>;
}

export interface ArchitectureProviderContext {
  runId: string;
  request: EngineeringRequest;
  validatedPlan: EngineeringPlan;
}

export interface ArchitectureProviderResult {
  ok: true;
  architecture: Omit<ArchitectureSpecification, "contentHash" | "createdAt" | "updatedAt" | "status" | "createdBy">;
}

export interface ArchitectureProvider {
  readonly providerId: string;
  architect(ctx: ArchitectureProviderContext): Promise<ArchitectureProviderResult | ProviderError>;
}
