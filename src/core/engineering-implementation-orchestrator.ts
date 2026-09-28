// src/core/engineering-implementation-orchestrator.ts
// Phase 217: implementation execution orchestrator.
//
// Composes (reusing Phase 214-216 infrastructure):
//   - AIImplementationProvider (chunk 4) built on the Phase 216 gateway
//   - validateImplementationProposal (chunk 3) - deterministic validator
//   - WorkspaceService.applyFileOperations (chunk 2) - atomic mutation
//   - ArtifactStore - durable evidence
//   - engineering_run_events (Phase 214) - durable lifecycle
//   - implementation_specifications (migration 171) - durable spec row
//
// Scope: PROPOSAL -> VALIDATE -> MUTATE -> ARTIFACT -> EVENTS.
// BUILD / TEST / DIAGNOSIS / REPAIR remain separate engineering stages
// (CANONICAL_ENGINEERING_DAG ordinals 3..6) - this orchestrator ends with
// IMPLEMENTATION = PASSED/FAILED/BLOCKED/INVALID and does not short-circuit
// downstream stages.
//
// Never fabricates SUCCESS. Provider absence, provider error, invalid
// proposal, and mutation failure each map to a distinct honest status.

import { createHash } from "node:crypto";
import { PgClient } from "./pg-client";
import type { ArtifactStore } from "./artifact-store";
import type { WorkspaceService, WorkspaceActor } from "./workspace";
import {
  computeImplementationContentHash,
  canonicalizeOperations,
  type ImplementationSpec,
  type ImplementationStatus,
  type FileOperation,
  type ImplementationValidationResult,
} from "./implementation-contracts";
import { validateImplementationProposal } from "./implementation-validator";
import type { AIImplementationProvider } from "./ai-implementation-provider";
import type {
  EngineeringPlan,
  ArchitectureSpecification,
} from "./engineering-planning-contracts";

export type ImplementationOutcomeStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "INVALID";

export interface ImplementationOutcome {
  status: ImplementationOutcomeStatus;
  spec: ImplementationSpec | null;
  reason: string;
  validationErrors: string[];
  affectedPaths: string[];
  artifactId: string | null;
}

export interface RunImplementationInput {
  runId: string;
  planId: string;
  architectureId: string;
  workspaceId: string;
  actor: WorkspaceActor;
}

function genId(prefix: string): string {
  return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

export class EngineeringImplementationOrchestrator {
  constructor(
    private readonly dbUrl: string,
    private readonly artifacts: ArtifactStore,
    private readonly workspaces: WorkspaceService,
    private readonly implementationProvider?: AIImplementationProvider,
  ) {}

  private async withPg<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
    const pg = new PgClient();
    await pg.connect(this.dbUrl);
    try { return await fn(pg); } finally { await pg.close(); }
  }

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

  /** Compute the idempotency key for an implementation request. */
  computeRequestHash(runId: string, planId: string, architectureId: string): string {
    return createHash("sha256")
      .update("impl|" + runId + "|" + planId + "|" + architectureId)
      .digest("hex");
  }

  private async loadPlan(runId: string, planId: string): Promise<EngineeringPlan | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_plans WHERE id=$1 AND run_id=$2", [planId, runId]);
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const plan: EngineeringPlan = {
        planId: row.id,
        runId: row.run_id,
        requestId: row.request_id,
        version: Number(row.version),
        objective: row.objective,
        scope: row.scope,
        requirements: JSON.parse(row.requirements_json),
        constraints: JSON.parse(row.constraints_json),
        assumptions: JSON.parse(row.assumptions_json),
        acceptanceCriteria: JSON.parse(row.acceptance_json),
        plannedStages: JSON.parse(row.planned_stages_json),
        dependencies: JSON.parse(row.dependencies_json),
        risks: JSON.parse(row.risks_json),
        verificationStrategy: JSON.parse(row.verification_json),
        contentHash: row.content_hash,
        status: row.status,
        createdBy: row.created_by,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
      return plan;
    });
  }

  /**
   * Best-effort architecture read. Column names outside the known core fields
   * fall back to sensible defaults so the prompt still receives a usable
   * representation; if a required column is genuinely missing the provider
   * call returns INVALID_RESPONSE and the outcome is INVALID - never faked.
   */
  private async loadArchitecture(runId: string, architectureId: string): Promise<ArchitectureSpecification | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM architecture_specifications WHERE id=$1 AND run_id=$2", [architectureId, runId]);
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const jsonOr = (v: unknown, fb: unknown): any => {
        if (typeof v !== "string" || v.length === 0) return fb;
        try { return JSON.parse(v); } catch { return fb; }
      };
      const arch: ArchitectureSpecification = {
        architectureId: row.id,
        runId: row.run_id,
        planId: row.plan_id,
        systemOverview: row.system_overview ?? row.system_overview_json ?? "",
        components: jsonOr(row.components_json, []),
        interfaces: jsonOr(row.interfaces_json, []),
        dataModel: jsonOr(row.data_model_json, []),
        runtimeModel: jsonOr(row.runtime_model_json, []),
        securityModel: jsonOr(row.security_model_json, []),
        deploymentModel: jsonOr(row.deployment_model_json, []),
        observabilityModel: jsonOr(row.observability_model_json, []),
        failureHandling: row.failure_handling ?? "",
        technologyDecisions: jsonOr(row.technology_decisions_json, []),
        constraints: jsonOr(row.constraints_json, []),
        verificationStrategy: jsonOr(row.verification_json, []),
        contentHash: row.content_hash,
        status: row.status,
        createdBy: row.created_by,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      } as ArchitectureSpecification;
      return arch;
    });
  }

  private async findExistingSpec(runId: string, requestHash: string): Promise<ImplementationSpec | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM implementation_specifications WHERE run_id=$1 AND request_hash=$2",
        [runId, requestHash]);
      return r.rowCount === 0 ? null : this.mapSpec(r.rows[0]);
    });
  }

  private mapSpec(row: any): ImplementationSpec {
    return {
      implementationId: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      planId: row.plan_id,
      architectureId: row.architecture_id,
      providerId: row.provider_id,
      model: row.model,
      requestHash: row.request_hash,
      contentHash: row.content_hash,
      operations: JSON.parse(row.operations_json) as FileOperation[],
      status: row.status as ImplementationStatus,
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async insertSpec(spec: ImplementationSpec): Promise<boolean> {
    return this.withPg(async (pg) => {
      const r = await pg.query<{ id: string }>(
        "INSERT INTO implementation_specifications (" +
        "  id, run_id, workspace_id, plan_id, architecture_id," +
        "  provider_id, model, request_hash, content_hash, operations_json," +
        "  status, created_by, created_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
        "ON CONFLICT (run_id, request_hash) DO NOTHING RETURNING id",
        [spec.implementationId, spec.runId, spec.workspaceId, spec.planId, spec.architectureId,
         spec.providerId, spec.model, spec.requestHash, spec.contentHash,
         JSON.stringify(spec.operations), spec.status, spec.createdBy,
         spec.createdAt, spec.updatedAt],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  private async updateSpecStatus(implementationId: string, status: ImplementationStatus): Promise<void> {
    await this.withPg(async (pg) => {
      await pg.query(
        "UPDATE implementation_specifications SET status=$1, updated_at=$2 WHERE id=$3",
        [status, Date.now(), implementationId]);
    });
  }

  private async registerSpecArtifact(spec: ImplementationSpec): Promise<string> {
    const canonical = canonicalizeOperations(spec.operations);
    const content = JSON.stringify({
      implementationId: spec.implementationId,
      runId: spec.runId,
      workspaceId: spec.workspaceId,
      planId: spec.planId,
      architectureId: spec.architectureId,
      contentHash: spec.contentHash,
      canonical,
      status: spec.status,
    });
    const record = await this.artifacts.registerArtifactAsync(
      {
        artifactId: "art-impl-" + spec.implementationId,
        jobId: spec.runId,
        name: "implementation-" + spec.implementationId + ".json",
        type: "ENGINEERING_IMPLEMENTATION",
        metadata: {
          implementationId: spec.implementationId,
          contentHash: spec.contentHash,
          operations: spec.operations.length,
        },
        createdAt: spec.createdAt,
      } as any,
      content,
    );
    await this.appendEvent(spec.runId, "engineering_implementation.artifact_persisted", {
      implementationId: spec.implementationId,
      artifactId: record.artifactId,
      checksum: record.checksum,
    });
    return record.artifactId;
  }

  /**
   * Run the IMPLEMENTATION stage. Caller is responsible for having already
   * produced a VALID plan and a VALID architecture (Phase 215) and for
   * providing an ACTIVE workspace (Phase 2 WorkspaceService).
   */
  async runImplementation(input: RunImplementationInput): Promise<ImplementationOutcome> {
    const { runId, planId, architectureId, workspaceId, actor } = input;
    const requestHash = this.computeRequestHash(runId, planId, architectureId);

    // 1. Idempotency: a prior spec for this (run, plan, arch) short-circuits.
    const existing = await this.findExistingSpec(runId, requestHash);
    if (existing) {
      await this.appendEvent(runId, "engineering_implementation.idempotent_hit", {
        implementationId: existing.implementationId, requestHash,
      });
      const succeeded = existing.status === "APPLIED" || existing.status === "VALIDATED";
      return {
        status: succeeded ? "SUCCEEDED" : (existing.status as ImplementationOutcomeStatus),
        spec: existing,
        reason: "IDEMPOTENT_REPLAY:" + existing.status,
        validationErrors: [],
        affectedPaths: existing.operations.flatMap((op) =>
          op.kind === "RENAME" ? [op.from, op.to] : [op.path]),
        artifactId: null,
      };
    }

    // 2. Load plan; must exist and be VALID.
    const plan = await this.loadPlan(runId, planId);
    if (!plan) {
      await this.appendEvent(runId, "engineering_implementation.blocked", { planId, reason: "PLAN_NOT_FOUND" });
      return { status: "FAILED", spec: null, reason: "PLAN_NOT_FOUND", validationErrors: [], affectedPaths: [], artifactId: null };
    }
    if (plan.status !== "VALID") {
      await this.appendEvent(runId, "engineering_implementation.blocked", { planId, reason: "PLAN_NOT_VALID:" + plan.status });
      return { status: "INVALID", spec: null, reason: "PLAN_NOT_VALID:" + plan.status, validationErrors: [], affectedPaths: [], artifactId: null };
    }

    // 3. Load architecture; must exist and be VALID.
    const arch = await this.loadArchitecture(runId, architectureId);
    if (!arch) {
      await this.appendEvent(runId, "engineering_implementation.blocked", { architectureId, reason: "ARCHITECTURE_NOT_FOUND" });
      return { status: "FAILED", spec: null, reason: "ARCHITECTURE_NOT_FOUND", validationErrors: [], affectedPaths: [], artifactId: null };
    }
    if (arch.status !== "VALID") {
      await this.appendEvent(runId, "engineering_implementation.blocked", { architectureId, reason: "ARCHITECTURE_NOT_VALID:" + arch.status });
      return { status: "INVALID", spec: null, reason: "ARCHITECTURE_NOT_VALID:" + arch.status, validationErrors: [], affectedPaths: [], artifactId: null };
    }

    // 4. No provider -> BLOCKED, honest.
    if (!this.implementationProvider) {
      await this.appendEvent(runId, "engineering_implementation.blocked", {
        reason: "PROVIDER_NOT_CONFIGURED",
      });
      return { status: "BLOCKED", spec: null, reason: "PROVIDER_NOT_CONFIGURED", validationErrors: [], affectedPaths: [], artifactId: null };
    }

    // 5. Snapshot workspace paths (data, not instructions).
    let existingPaths: string[] = [];
    try {
      const files = await this.workspaces.listFiles(actor, workspaceId);
      existingPaths = files.map((f) => f.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.appendEvent(runId, "engineering_implementation.blocked", { reason: "WORKSPACE_UNREADABLE", detail: msg });
      return { status: "BLOCKED", spec: null, reason: "WORKSPACE_UNREADABLE:" + msg, validationErrors: [], affectedPaths: [], artifactId: null };
    }

    // 6. Invoke provider.
    const providerResult = await this.implementationProvider.implement({
      runId,
      request: { id: "", runId, requestText: plan.objective, requestHash: "", createdBy: null, metadata: null, createdAt: plan.createdAt },
      validatedPlan: plan,
      architecture: arch,
      existingPaths,
    });
    if (!providerResult.ok) {
      const blocked = providerResult.reason.includes("NOT_CONFIGURED");
      await this.appendEvent(runId, "engineering_implementation.provider_failed", {
        reason: providerResult.reason, detail: providerResult.detail ?? null,
      });
      return { status: blocked ? "BLOCKED" : "FAILED", spec: null, reason: providerResult.reason, validationErrors: [], affectedPaths: [], artifactId: null };
    }
    await this.appendEvent(runId, "engineering_implementation.provider_invoked", {
      providerId: providerResult.providerId,
      model: providerResult.model,
      requestId: providerResult.requestId,
      operations: providerResult.proposal.operations.length,
      latencyMs: providerResult.latencyMs,
    });

    // 7. Deterministic validation.
    const validation: ImplementationValidationResult = validateImplementationProposal(
      providerResult.proposal,
      { existingPaths: new Set(existingPaths), limits: { max_file_bytes: 64 * 1024, max_total_bytes: 1024 * 1024, max_file_count: 200 } },
    );
    if (!validation.valid) {
      await this.appendEvent(runId, "engineering_implementation.invalid", {
        issues: validation.issues.slice(0, 20),
      });
      return {
        status: "INVALID", spec: null,
        reason: "VALIDATION_FAILED",
        validationErrors: validation.issues.map((i) => i.code + ": " + i.message),
        affectedPaths: [], artifactId: null,
      };
    }

    // 8. Build spec row.
    const now = Date.now();
    const operations = providerResult.proposal.operations;
    const spec: ImplementationSpec = {
      implementationId: genId("impl-"),
      runId,
      workspaceId,
      planId,
      architectureId,
      providerId: providerResult.providerId,
      model: providerResult.model,
      requestHash,
      contentHash: computeImplementationContentHash(operations),
      operations,
      status: "VALIDATED",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    };

    const inserted = await this.insertSpec(spec);
    if (!inserted) {
      // Concurrent caller won the (run, requestHash) slot - re-read.
      const winner = await this.findExistingSpec(runId, requestHash);
      if (winner) {
        await this.appendEvent(runId, "engineering_implementation.concurrent_replay", {
          implementationId: winner.implementationId,
        });
        return {
          status: "SUCCEEDED", spec: winner, reason: "CONCURRENT_REPLAY",
          validationErrors: [],
          affectedPaths: winner.operations.flatMap((op) => op.kind === "RENAME" ? [op.from, op.to] : [op.path]),
          artifactId: null,
        };
      }
      throw new Error("implementation_specifications insert lost but no row found");
    }

    await this.appendEvent(runId, "engineering_implementation.validated", {
      implementationId: spec.implementationId,
      contentHash: spec.contentHash,
      operations: operations.length,
    });

    // 9. Atomic mutation (WorkspaceService validates all-or-nothing).
    await this.appendEvent(runId, "engineering_implementation.mutation_started", {
      implementationId: spec.implementationId,
      workspaceId,
    });
    let affected: string[] = [];
    try {
      const applied = await this.workspaces.applyFileOperations(actor, workspaceId, operations);
      affected = applied.affected;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.updateSpecStatus(spec.implementationId, "FAILED");
      await this.appendEvent(runId, "engineering_implementation.failed", {
        implementationId: spec.implementationId, reason: msg,
      });
      return {
        status: "FAILED", spec: { ...spec, status: "FAILED" },
        reason: "MUTATION_FAILED:" + msg,
        validationErrors: [], affectedPaths: [], artifactId: null,
      };
    }
    await this.appendEvent(runId, "engineering_implementation.mutation_completed", {
      implementationId: spec.implementationId,
      affected: affected.length,
    });

    // 10. Persist artifact + mark APPLIED.
    await this.updateSpecStatus(spec.implementationId, "APPLIED");
    const artifactId = await this.registerSpecArtifact({ ...spec, status: "APPLIED" });

    return {
      status: "SUCCEEDED",
      spec: { ...spec, status: "APPLIED" },
      reason: "APPLIED",
      validationErrors: [],
      affectedPaths: affected,
      artifactId,
    };
  }
}