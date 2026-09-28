// src/core/engineering-planning-orchestrator.ts
// Phase 215: planning + architecture execution orchestrator.
//
// Composes:
//   - provider-neutral PlanningProvider / ArchitectureProvider contracts
//   - deterministic validators (engineering-plan-validator.ts)
//   - durable tables engineering_requests / engineering_plans /
//     architecture_specifications
//   - engineering_run_events (Phase 214)
//   - ArtifactStore (Phase 136/188) for authoritative artifacts
//
// NO concrete production provider ships with this phase. If no provider is
// configured, planning/architecture return BLOCKED with reason
// PROVIDER_NOT_CONFIGURED — never a fake SUCCESS.

import { createHash } from "node:crypto";
import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { ArtifactStore } from "./artifact-store";
import {
  computePlanContentHash,
  computeArchitectureContentHash,
  validateEngineeringPlan,
  validateArchitectureSpecification,
  type ValidationResult,
} from "./engineering-plan-validator";
import type {
  EngineeringRequest,
  EngineeringPlan,
  ArchitectureSpecification,
  PlanningProvider,
  ArchitectureProvider,
  ProviderContext,
  ArchitectureProviderContext,
  ProviderError,
  PlanProviderResult,
  ArchitectureProviderResult,
  EngineeringPlanStatus,
  ArchitectureStatus,
} from "./engineering-planning-contracts";

export interface SubmitRequestInput {
  runId: string;
  requestText: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitRequestResult {
  request: EngineeringRequest;
  created: boolean;
}

export type PlanningOutcomeStatus = "SUCCEEDED" | "FAILED" | "BLOCKED" | "INVALID";
export interface PlanningOutcome {
  status: PlanningOutcomeStatus;
  plan: EngineeringPlan | null;
  reason: string;
  validationErrors: string[];
}

export type ArchitectureOutcomeStatus = "SUCCEEDED" | "FAILED" | "BLOCKED" | "INVALID";
export interface ArchitectureOutcome {
  status: ArchitectureOutcomeStatus;
  architecture: ArchitectureSpecification | null;
  reason: string;
  validationErrors: string[];
}

function genId(prefix: string): string {
  return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export class EngineeringPlanningOrchestrator {
  constructor(
    private readonly dbUrl: string,
    private readonly store: ExecutionStore,
    private readonly artifacts: ArtifactStore,
    private readonly planningProvider?: PlanningProvider,
    private readonly architectureProvider?: ArchitectureProvider,
  ) {}

  private async withPg<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
    const pg = new PgClient();
    await pg.connect(this.dbUrl);
    try { return await fn(pg); } finally { await pg.close(); }
  }

  // ---------------- Requests ----------------

  computeRequestHash(runId: string, requestText: string): string {
    return createHash("sha256")
      .update(runId + "|" + normalizeText(requestText).toLowerCase())
      .digest("hex");
  }

  async submitRequest(input: SubmitRequestInput): Promise<SubmitRequestResult> {
    if (!input.runId) throw new Error("submitRequest: runId is required");
    if (!input.requestText || !input.requestText.trim()) {
      throw new Error("submitRequest: requestText is required");
    }
    const hash = this.computeRequestHash(input.runId, input.requestText);
    const now = Date.now();

    // Fast path
    const existing = await this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_requests WHERE run_id=$1 AND request_hash=$2",
        [input.runId, hash]);
      return r.rowCount === 0 ? null : this.mapRequest(r.rows[0]);
    });
    if (existing) return { request: existing, created: false };

    const request: EngineeringRequest = {
      id: genId("ereq-"),
      runId: input.runId,
      requestText: input.requestText,
      requestHash: hash,
      createdBy: input.createdBy ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
    };

    const inserted = await this.withPg(async (pg) => {
      const r = await pg.query<{ id: string }>(
        "INSERT INTO engineering_requests (" +
        "  id, run_id, request_text, request_hash, created_by, metadata, created_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7) " +
        "ON CONFLICT (run_id, request_hash) DO NOTHING RETURNING id",
        [request.id, request.runId, request.requestText, request.requestHash,
         request.createdBy, request.metadata ? JSON.stringify(request.metadata) : null,
         request.createdAt],
      );
      return (r.rowCount ?? 0) > 0;
    });

    if (!inserted) {
      const winner = await this.withPg(async (pg) => {
        const r = await pg.query<any>(
          "SELECT * FROM engineering_requests WHERE run_id=$1 AND request_hash=$2",
          [input.runId, hash]);
        return r.rowCount === 0 ? null : this.mapRequest(r.rows[0]);
      });
      if (!winner) throw new Error("engineering_requests conflict but winner not found");
      return { request: winner, created: false };
    }

    await this.appendEvent(input.runId, "engineering_request.created", {
      requestId: request.id, requestHash: request.requestHash,
    });
    return { request, created: true };
  }

  async getRequest(runId: string, requestId: string): Promise<EngineeringRequest | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_requests WHERE run_id=$1 AND id=$2",
        [runId, requestId]);
      return r.rowCount === 0 ? null : this.mapRequest(r.rows[0]);
    });
  }

  // ---------------- Planning ----------------

  async runPlanning(runId: string, requestId: string): Promise<PlanningOutcome> {
    const request = await this.getRequest(runId, requestId);
    if (!request) {
      return { status: "FAILED", plan: null, reason: "REQUEST_NOT_FOUND", validationErrors: [] };
    }

    // Phase 215: idempotent. If a plan already exists for this exact
    // (runId, requestId), return it without re-invoking the provider.
    const existing = await this.findExistingPlanForRequest(runId, requestId);
    if (existing) {
      if (existing.status === "VALID") {
        return { status: "SUCCEEDED", plan: existing, reason: "IDEMPOTENT", validationErrors: [] };
      }
      if (existing.status === "INVALID") {
        return { status: "INVALID", plan: existing, reason: "IDEMPOTENT_INVALID", validationErrors: [] };
      }
      // SUPERSEDED → fall through and produce a new version
    }

    if (!this.planningProvider) {
      await this.appendEvent(runId, "engineering_planning.blocked", {
        requestId, reason: "PROVIDER_NOT_CONFIGURED",
      });
      return {
        status: "BLOCKED", plan: null,
        reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [],
      };
    }

    await this.appendEvent(runId, "engineering_planning.started", {
      requestId, providerId: this.planningProvider.providerId,
    });

    const ctx: ProviderContext = { runId, request };
    let providerResult: PlanProviderResult | ProviderError;
    try {
      providerResult = await this.planningProvider.plan(ctx);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, "engineering_planning.failed", { requestId, reason });
      return { status: "FAILED", plan: null, reason, validationErrors: [] };
    }
    if (!providerResult.ok) {
      await this.appendEvent(runId, "engineering_planning.failed", {
        requestId, reason: providerResult.reason, detail: providerResult.detail ?? null,
      });
      return {
        status: "FAILED", plan: null,
        reason: providerResult.reason, validationErrors: [],
      };
    }

    // Deterministic validation BEFORE persistence.
    const now = Date.now();
    const plan: EngineeringPlan = {
      ...providerResult.plan,
      status: "VALIDATING",
      contentHash: "",
      createdBy: this.planningProvider.providerId,
      createdAt: now, updatedAt: now,
    };
    // contentHash is not part of its own hashing target.
    const { contentHash: _drop, ...hashable } = plan;
    plan.contentHash = computePlanContentHash(hashable as any);

    const validation = validateEngineeringPlan(plan);
    if (!validation.ok) {
      plan.status = "INVALID";
      await this.persistPlan(plan);
      await this.appendEvent(runId, "engineering_plan.invalid", {
        planId: plan.planId, errors: validation.errors,
      });
      return {
        status: "INVALID", plan,
        reason: "VALIDATION_FAILED", validationErrors: validation.errors,
      };
    }

    plan.status = "VALID";
    plan.updatedAt = now;
    await this.persistPlan(plan);
    await this.supersedeOlderPlans(runId, plan.version);
    await this.registerPlanArtifact(runId, plan);
    await this.appendEvent(runId, "engineering_plan.validated", {
      planId: plan.planId, version: plan.version, contentHash: plan.contentHash,
    });

    return { status: "SUCCEEDED", plan, reason: "VALIDATED", validationErrors: [] };
  }

  private async persistPlan(plan: EngineeringPlan): Promise<void> {
    try {
      await this.withPg(async (pg) => {
        await pg.query(
          "INSERT INTO engineering_plans (" +
          "  id, run_id, request_id, version, objective, scope," +
          "  requirements_json, constraints_json, assumptions_json, acceptance_json," +
          "  planned_stages_json, dependencies_json, risks_json, verification_json," +
          "  status, content_hash, created_by, created_at, updated_at" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
          [plan.planId, plan.runId, plan.requestId, plan.version,
           plan.objective, plan.scope,
           JSON.stringify(plan.requirements), JSON.stringify(plan.constraints),
           JSON.stringify(plan.assumptions), JSON.stringify(plan.acceptanceCriteria),
           JSON.stringify(plan.plannedStages), JSON.stringify(plan.dependencies),
           JSON.stringify(plan.risks), JSON.stringify(plan.verificationStrategy),
           plan.status, plan.contentHash, plan.createdBy, plan.createdAt, plan.updatedAt],
        );
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key/i.test(msg) || /unique constraint/i.test(msg)) {
        // Concurrent caller won the (run_id, version) slot — benign.
        return;
      }
      throw e;
    }
  }

  private async supersedeOlderPlans(runId: string, currentVersion: number): Promise<void> {
    await this.withPg(async (pg) => {
      await pg.query(
        "UPDATE engineering_plans SET status='SUPERSEDED', updated_at=$1 " +
        "WHERE run_id=$2 AND version < $3 AND status='VALID'",
        [Date.now(), runId, currentVersion],
      );
    });
  }

  private async registerPlanArtifact(runId: string, plan: EngineeringPlan): Promise<string> {
    const content = JSON.stringify(plan);
    const record = await this.artifacts.registerArtifactAsync(
      {
        artifactId: "art-plan-" + plan.planId,
        jobId: runId,
        name: "plan-" + plan.planId + ".json",
        type: "ENGINEERING_PLAN",
        metadata: { planId: plan.planId, version: plan.version, contentHash: plan.contentHash },
        createdAt: plan.createdAt,
      } as any,
      content,
    );
    await this.appendEvent(runId, "engineering_plan.artifact_persisted", {
      planId: plan.planId, artifactId: record.artifactId, checksum: record.checksum,
    });
    return record.artifactId;
  }

  // ---------------- Architecture ----------------

  async runArchitecture(runId: string, planId: string): Promise<ArchitectureOutcome> {
    const plan = await this.getPlan(runId, planId);
    if (!plan) {
      return { status: "FAILED", architecture: null, reason: "PLAN_NOT_FOUND", validationErrors: [] };
    }
    if (plan.status !== "VALID") {
      return {
        status: "INVALID", architecture: null,
        reason: "PLAN_NOT_VALID:" + plan.status, validationErrors: [],
      };
    }

    if (!this.architectureProvider) {
      await this.appendEvent(runId, "engineering_architecture.blocked", {
        planId, reason: "PROVIDER_NOT_CONFIGURED",
      });
      return {
        status: "BLOCKED", architecture: null,
        reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [],
      };
    }

    const request = await this.getRequest(runId, plan.requestId);
    if (!request) {
      return { status: "FAILED", architecture: null, reason: "REQUEST_NOT_FOUND", validationErrors: [] };
    }

    await this.appendEvent(runId, "engineering_architecture.started", {
      planId, providerId: this.architectureProvider.providerId,
    });

    const ctx: ArchitectureProviderContext = { runId, request, validatedPlan: plan };
    let providerResult: ArchitectureProviderResult | ProviderError;
    try {
      providerResult = await this.architectureProvider.architect(ctx);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, "engineering_architecture.failed", { planId, reason });
      return { status: "FAILED", architecture: null, reason, validationErrors: [] };
    }
    if (!providerResult.ok) {
      await this.appendEvent(runId, "engineering_architecture.failed", {
        planId, reason: providerResult.reason, detail: providerResult.detail ?? null,
      });
      return {
        status: "FAILED", architecture: null,
        reason: providerResult.reason, validationErrors: [],
      };
    }

    const now = Date.now();
    const arch: ArchitectureSpecification = {
      ...providerResult.architecture,
      status: "VALIDATING",
      contentHash: "",
      createdBy: this.architectureProvider.providerId,
      createdAt: now, updatedAt: now,
    };
    const { contentHash: _drop2, ...hashable2 } = arch;
    arch.contentHash = computeArchitectureContentHash(hashable2 as any);

    const validation = validateArchitectureSpecification(arch, plan);
    if (!validation.ok) {
      arch.status = "INVALID";
      await this.persistArchitecture(arch);
      await this.appendEvent(runId, "engineering_architecture.invalid", {
        architectureId: arch.architectureId, errors: validation.errors,
      });
      return {
        status: "INVALID", architecture: arch,
        reason: "VALIDATION_FAILED", validationErrors: validation.errors,
      };
    }

    arch.status = "VALID";
    arch.updatedAt = now;
    await this.persistArchitecture(arch);
    await this.supersedeOlderArchitectures(runId, arch.version);
    await this.registerArchitectureArtifact(runId, arch);
    await this.appendEvent(runId, "engineering_architecture.validated", {
      architectureId: arch.architectureId, planId: arch.planId,
      version: arch.version, contentHash: arch.contentHash,
    });
    return { status: "SUCCEEDED", architecture: arch, reason: "VALIDATED", validationErrors: [] };
  }

  private async persistArchitecture(arch: ArchitectureSpecification): Promise<void> {
    await this.withPg(async (pg) => {
      await pg.query(
        "INSERT INTO architecture_specifications (" +
        "  id, run_id, plan_id, version, system_overview, components_json, interfaces_json," +
        "  data_model_json, runtime_model_json, security_model_json, deployment_json," +
        "  observability_json, failure_handling, technology_json, constraints_json," +
        "  verification_json, status, content_hash, created_by, created_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
        [arch.architectureId, arch.runId, arch.planId, arch.version, arch.systemOverview,
         JSON.stringify(arch.components), JSON.stringify(arch.interfaces),
         JSON.stringify(arch.dataModel), JSON.stringify(arch.runtimeModel),
         JSON.stringify(arch.securityModel), JSON.stringify(arch.deploymentModel),
         JSON.stringify(arch.observabilityModel), arch.failureHandling,
         JSON.stringify(arch.technologyDecisions), JSON.stringify(arch.constraints),
         JSON.stringify(arch.verificationStrategy), arch.status, arch.contentHash,
         arch.createdBy, arch.createdAt, arch.updatedAt],
      );
    });
  }

  private async supersedeOlderArchitectures(runId: string, currentVersion: number): Promise<void> {
    await this.withPg(async (pg) => {
      await pg.query(
        "UPDATE architecture_specifications SET status='SUPERSEDED', updated_at=$1 " +
        "WHERE run_id=$2 AND version < $3 AND status='VALID'",
        [Date.now(), runId, currentVersion],
      );
    });
  }

  private async registerArchitectureArtifact(runId: string, arch: ArchitectureSpecification): Promise<string> {
    const content = JSON.stringify(arch);
    const record = await this.artifacts.registerArtifactAsync(
      {
        artifactId: "art-arch-" + arch.architectureId,
        jobId: runId,
        name: "architecture-" + arch.architectureId + ".json",
        type: "ARCHITECTURE_SPECIFICATION",
        metadata: { architectureId: arch.architectureId, planId: arch.planId,
                    version: arch.version, contentHash: arch.contentHash },
        createdAt: arch.createdAt,
      } as any,
      content,
    );
    await this.appendEvent(runId, "engineering_architecture.artifact_persisted", {
      architectureId: arch.architectureId, artifactId: record.artifactId, checksum: record.checksum,
    });
    return record.artifactId;
  }

  // ---------------- Read paths ----------------

  async getPlan(runId: string, planId: string): Promise<EngineeringPlan | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_plans WHERE run_id=$1 AND id=$2", [runId, planId]);
      return r.rowCount === 0 ? null : this.mapPlan(r.rows[0]);
    });
  }

  async getLatestPlan(runId: string): Promise<EngineeringPlan | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_plans WHERE run_id=$1 ORDER BY version DESC LIMIT 1", [runId]);
      return r.rowCount === 0 ? null : this.mapPlan(r.rows[0]);
    });
  }

  async getArchitecture(runId: string, architectureId: string): Promise<ArchitectureSpecification | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM architecture_specifications WHERE run_id=$1 AND id=$2",
        [runId, architectureId]);
      return r.rowCount === 0 ? null : this.mapArchitecture(r.rows[0]);
    });
  }

  async getLatestArchitecture(runId: string): Promise<ArchitectureSpecification | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM architecture_specifications WHERE run_id=$1 ORDER BY version DESC LIMIT 1",
        [runId]);
      return r.rowCount === 0 ? null : this.mapArchitecture(r.rows[0]);
    });
  }

  // ---------------- Internals ----------------

  private async appendEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventId = genId("eevt-");
    const now = Date.now();
    await this.withPg(async (pg) => {
      await pg.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
        [eventId, runId, null, eventType, JSON.stringify(payload), now],
      );
    });
  }

  private async findExistingPlanForRequest(runId: string, requestId: string): Promise<EngineeringPlan | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_plans WHERE run_id=$1 AND request_id=$2 ORDER BY version DESC LIMIT 1",
        [runId, requestId]);
      return r.rowCount === 0 ? null : this.mapPlan(r.rows[0]);
    });
  }

  private mapRequest(row: any): EngineeringRequest {
    return {
      id: row.id, runId: row.run_id, requestText: row.request_text,
      requestHash: row.request_hash, createdBy: row.created_by,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: Number(row.created_at),
    };
  }

  private mapPlan(row: any): EngineeringPlan {
    return {
      planId: row.id, runId: row.run_id, requestId: row.request_id,
      version: Number(row.version), objective: row.objective, scope: row.scope,
      requirements: JSON.parse(row.requirements_json),
      constraints: JSON.parse(row.constraints_json),
      assumptions: JSON.parse(row.assumptions_json),
      acceptanceCriteria: JSON.parse(row.acceptance_json),
      plannedStages: JSON.parse(row.planned_stages_json),
      dependencies: JSON.parse(row.dependencies_json),
      risks: JSON.parse(row.risks_json),
      verificationStrategy: JSON.parse(row.verification_json),
      status: row.status as EngineeringPlanStatus,
      contentHash: row.content_hash, createdBy: row.created_by,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  private mapArchitecture(row: any): ArchitectureSpecification {
    return {
      architectureId: row.id, runId: row.run_id, planId: row.plan_id,
      version: Number(row.version), systemOverview: row.system_overview,
      components: JSON.parse(row.components_json),
      interfaces: JSON.parse(row.interfaces_json),
      dataModel: JSON.parse(row.data_model_json),
      runtimeModel: JSON.parse(row.runtime_model_json),
      securityModel: JSON.parse(row.security_model_json),
      deploymentModel: JSON.parse(row.deployment_json),
      observabilityModel: JSON.parse(row.observability_json),
      failureHandling: row.failure_handling ?? "",
      technologyDecisions: JSON.parse(row.technology_json),
      constraints: JSON.parse(row.constraints_json),
      verificationStrategy: JSON.parse(row.verification_json),
      status: row.status as ArchitectureStatus,
      contentHash: row.content_hash, createdBy: row.created_by,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
}
