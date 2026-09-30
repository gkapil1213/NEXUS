// src/core/engineering-run-service.ts
// Phase 214: durable engineering run orchestration.
//
// An engineering run is a thin metadata layer over the existing Phase 201-213
// execution infrastructure:
//   - engineering_runs.id        === execution_jobs.id  (job_type "engineering.run")
//   - engineering_run_stages.id  === execution_jobs.id  (job_type "engineering.stage")
//   - dependencies live in execution_stage_dependencies (Phase 201)
//   - lifecycle transitions reuse the existing store primitives
//
// Phase 214 establishes the durable orchestration contract. It does NOT
// pretend any AI capability exists: stages whose executor is unwired are
// persisted as BLOCKED with an honest reason and never reach SUCCEEDED.

import { PgClient } from "./pg-client";
import type { ExecutionStore } from "./execution-store";
import type { AsyncStageDependencyStore } from "./stage-dependency-store";
import {
  EngineeringCapabilityRegistry,
  CANONICAL_ENGINEERING_DAG,
  type EngineeringStageType,
  type CapabilityStatus,
} from "./engineering-capability-registry";

export interface CreateEngineeringRunInput {
  objective: string;
  repository: string;
  sourceRevision?: string;
  idempotencyKey?: string;
  requestedBy?: string;
  executionContext?: Record<string, unknown>;
}

export interface EngineeringRun {
  id: string;
  idempotencyKey: string;
  objective: string;
  normalizedObjective: string;
  repository: string;
  sourceRevision: string | null;
  currentStage: string | null;
  revision: number;
  correlationId: string;
  requestedBy: string | null;
  executionContext: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EngineeringRunStage {
  id: string;
  runId: string;
  stageType: EngineeringStageType;
  ordinal: number;
  capabilityStatus: CapabilityStatus;
  capabilityReason: string | null;
  blockedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  artifactRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EngineeringRunEvent {
  eventId: string;
  runId: string;
  stageId: string | null;
  eventType: string;
  payload: string | null;
  createdAt: number;
}

export interface CreateEngineeringRunResult {
  run: EngineeringRun;
  created: boolean;
  stages: EngineeringRunStage[];
}

function genId(prefix: string): string {
  return prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function normalizeObjective(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export class EngineeringRunService {
  private readonly caps: EngineeringCapabilityRegistry;

  constructor(
    private readonly dbUrl: string,
    private readonly store: ExecutionStore,
    caps?: EngineeringCapabilityRegistry,
  ) {
    this.caps = caps ?? new EngineeringCapabilityRegistry();
  }

  private async withPg<T>(fn: (pg: PgClient) => Promise<T>): Promise<T> {
    const pg = new PgClient();
    await pg.connect(this.dbUrl);
    try { return await fn(pg); } finally { await pg.close(); }
  }

  // Deterministic idempotency key from immutable inputs. Same repository +
  // same normalized objective + same sourceRevision → same key → same run.
  computeIdempotencyKey(input: CreateEngineeringRunInput): string {
    const parts = [
      "engineering-run",
      input.repository,
      normalizeObjective(input.objective),
      input.sourceRevision ?? "HEAD",
    ];
    return parts.join("|");
  }

  async createEngineeringRun(input: CreateEngineeringRunInput): Promise<CreateEngineeringRunResult> {
    if (!input.objective || !input.objective.trim()) {
      throw new Error("createEngineeringRun: objective is required");
    }
    if (!input.repository || !input.repository.trim()) {
      throw new Error("createEngineeringRun: repository is required");
    }
    const idemKey = input.idempotencyKey ?? this.computeIdempotencyKey(input);
    const normalized = normalizeObjective(input.objective);
    const now = Date.now();

    // Fast path: already exists?
    const existing = await this.getEngineeringRunByIdempotencyKey(idemKey);
    if (existing) {
      const stages = await this.getEngineeringRunStages(existing.id);
      return { run: existing, created: false, stages };
    }

    const runId = genId("engrun-");
    const correlationId = genId("corr-");
    const contextJson = input.executionContext ? JSON.stringify(input.executionContext) : null;

    const run: EngineeringRun = {
      id: runId,
      idempotencyKey: idemKey,
      objective: input.objective,
      normalizedObjective: normalized,
      repository: input.repository,
      sourceRevision: input.sourceRevision ?? null,
      currentStage: null,
      revision: 1,
      correlationId,
      requestedBy: input.requestedBy ?? null,
      executionContext: contextJson,
      createdAt: now,
      updatedAt: now,
    };

    // Insert engineering_runs row. UNIQUE(idempotency_key) makes this the
    // concurrency boundary: two racing creators, exactly one wins.
    const inserted = await this.withPg(async (pg) => {
      const r = await pg.query<{ id: string }>(
        "INSERT INTO engineering_runs (" +
        "  id, idempotency_key, objective, normalized_objective, repository," +
        "  source_revision, current_stage, revision, correlation_id," +
        "  requested_by, execution_context, created_at, updated_at" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) " +
        "ON CONFLICT (idempotency_key) DO NOTHING " +
        "RETURNING id",
        [run.id, run.idempotencyKey, run.objective, run.normalizedObjective,
         run.repository, run.sourceRevision, run.currentStage, run.revision,
         run.correlationId, run.requestedBy, run.executionContext,
         run.createdAt, run.updatedAt],
      );
      return r.rowCount === 1;
    });

    if (!inserted) {
      // Lost the race: another creator won. Return the winner.
      const winner = await this.getEngineeringRunByIdempotencyKey(idemKey);
      if (!winner) throw new Error("engineering_runs idempotency conflict but winner not found");
      const stages = await this.getEngineeringRunStages(winner.id);
      return { run: winner, created: false, stages };
    }

    // Persist parent execution_jobs row so the run participates in the
    // existing recovery/finalization pipeline (Phase 207/213).
    await this.store.createJobAsync({
      id: run.id,
      idempotencyKey: "exec-" + run.idempotencyKey,
      jobType: "engineering.run",
      payload: { engineeringRunId: run.id, repository: run.repository, sourceRevision: run.sourceRevision },
      status: "RUNNING",
      priority: -2000000000,
      createdAt: now,
      updatedAt: now,
      cancellationRequested: false,
      cancellationAcknowledged: false,
    } as any);

    // Create canonical stages + dependencies + events.
    const stages: EngineeringRunStage[] = [];
    for (const spec of CANONICAL_ENGINEERING_DAG) {
      const verdict = this.caps.evaluate(spec.stageType);
      const stageId = `${run.id}__${spec.stageType}`;
      const stage: EngineeringRunStage = {
        id: stageId,
        runId: run.id,
        stageType: spec.stageType,
        ordinal: spec.ordinal,
        capabilityStatus: verdict.status,
        capabilityReason: verdict.reason,
        blockedAt: verdict.status === "AVAILABLE" ? null : now,
        startedAt: null,
        completedAt: null,
        artifactRef: null,
        createdAt: now,
        updatedAt: now,
      };

      // Duplicate as an execution_jobs row (pipeline.stage) so DAG eligibility
      // and dispatch work unchanged (Phase 201/202/203/207/213).
      const jobStatus = verdict.status === "AVAILABLE" ? "QUEUED" : "BLOCKED";
      await this.store.createJobAsync({
        id: stageId,
        idempotencyKey: "exec-" + stageId,
        jobType: "engineering.stage",
        payload: { kind: "engineering.stage", runId: run.id, stageType: spec.stageType },
        status: jobStatus,
        priority: -2000000000,
        createdAt: now,
        updatedAt: now,
        cancellationRequested: false,
        cancellationAcknowledged: false,
      } as any);

      await this.withPg(async (pg) => {
        await pg.query(
          "INSERT INTO engineering_run_stages (" +
          "  id, run_id, stage_type, ordinal, capability_status, capability_reason," +
          "  blocked_at, started_at, completed_at, artifact_ref, created_at, updated_at" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [stage.id, stage.runId, stage.stageType, stage.ordinal,
           stage.capabilityStatus, stage.capabilityReason,
           stage.blockedAt, stage.startedAt, stage.completedAt, stage.artifactRef,
           stage.createdAt, stage.updatedAt],
        );
      });

      stages.push(stage);
    }

    // Dependencies via the canonical Phase 201 store.
    const deps: AsyncStageDependencyStore | undefined = (this.store as any).stageDepsAsync;
    if (!deps) throw new Error("EngineeringRunService requires shared mode (stageDepsAsync)");
    for (const spec of CANONICAL_ENGINEERING_DAG) {
      for (const upstream of spec.dependsOn) {
        const r = await deps.add({
          executionId: run.id,
          stageName: spec.stageType,
          dependsOnStage: upstream,
        });
        if (!r.ok && r.reason !== "DUPLICATE_EDGE") {
          throw new Error(`dep ${upstream}->${spec.stageType}: ${r.reason}`);
        }
      }
    }

    // Journal events.
    const blocked = stages.filter((s) => s.capabilityStatus !== "AVAILABLE");
    await this.appendEvent(run.id, null, "engineering_run.created", {
      runId: run.id, objective: run.objective, repository: run.repository,
      sourceRevision: run.sourceRevision, stageCount: stages.length,
    });
    for (const s of stages) {
      await this.appendEvent(run.id, s.id, "engineering_run.stage_created", {
        stageId: s.id, stageType: s.stageType, ordinal: s.ordinal,
        capabilityStatus: s.capabilityStatus, capabilityReason: s.capabilityReason,
      });
      if (s.capabilityStatus !== "AVAILABLE") {
        await this.appendEvent(run.id, s.id, "engineering_run.stage_blocked", {
          stageId: s.id, stageType: s.stageType, reason: s.capabilityReason,
        });
      }
    }
    if (blocked.length > 0) {
      await this.appendEvent(run.id, null, "engineering_run.blocked", {
        reason: "one or more stages lack a wired executor",
        blockedStages: blocked.map((s) => s.stageType),
      });
    }

    return { run, created: true, stages };
  }

  // ---------------- Read paths ----------------

  async getEngineeringRun(runId: string): Promise<EngineeringRun | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_runs WHERE id = $1", [runId]);
      if (r.rowCount === 0) return null;
      return this.mapRun(r.rows[0]);
    });
  }

  async getEngineeringRunByIdempotencyKey(key: string): Promise<EngineeringRun | null> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_runs WHERE idempotency_key = $1", [key]);
      if (r.rowCount === 0) return null;
      return this.mapRun(r.rows[0]);
    });
  }

  async getEngineeringRunStages(runId: string): Promise<EngineeringRunStage[]> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_run_stages WHERE run_id = $1 ORDER BY ordinal ASC",
        [runId]);
      return r.rows.map((row) => this.mapStage(row));
    });
  }

  async getEngineeringRunEvents(runId: string): Promise<EngineeringRunEvent[]> {
    return this.withPg(async (pg) => {
      const r = await pg.query<any>(
        "SELECT * FROM engineering_run_events WHERE run_id = $1 ORDER BY created_at ASC, event_id ASC",
        [runId]);
      return r.rows.map((row) => this.mapEvent(row));
    });
  }

  // ---------------- Stage transitions ----------------

  /**
   * A stage may transition only through a bounded set of edges. All
   * transitions require the caller to state the expected precondition; the
   * SQL CAS rejects any concurrent mutation.
   */
  async transitionStage(input: {
    runId: string;
    stageId: string;
    expectedCapabilityStatus: CapabilityStatus;
    newCapabilityStatus: CapabilityStatus;
    artifactRef?: string | null;
    reason?: string;
  }): Promise<{ ok: boolean; updated: boolean; reason: string }> {
    const now = Date.now();
    const allowed: Record<CapabilityStatus, CapabilityStatus[]> = {
      AVAILABLE: ["AVAILABLE"],
      UNAVAILABLE: ["AVAILABLE", "NOT_IMPLEMENTED", "UNAVAILABLE"],
      NOT_IMPLEMENTED: ["AVAILABLE", "NOT_IMPLEMENTED", "UNAVAILABLE"],
    };
    if (!allowed[input.expectedCapabilityStatus]?.includes(input.newCapabilityStatus)) {
      return { ok: false, updated: false, reason: "ILLEGAL_STAGE_TRANSITION" };
    }
    const r = await this.withPg(async (pg) => {
      const res = await pg.query(
        "UPDATE engineering_run_stages SET " +
        "  capability_status = $1, capability_reason = COALESCE($2, capability_reason)," +
        "  blocked_at = CASE WHEN $1 = 'AVAILABLE' THEN NULL ELSE blocked_at END," +
        "  started_at = CASE WHEN $1 = 'AVAILABLE' AND started_at IS NULL THEN $3 ELSE started_at END," +
        "  artifact_ref = COALESCE($4, artifact_ref)," +
        "  updated_at = $3 " +
        "WHERE id = $5 AND run_id = $6 AND capability_status = $7",
        [input.newCapabilityStatus, input.reason ?? null, now,
         input.artifactRef ?? null, input.stageId, input.runId,
         input.expectedCapabilityStatus],
      );
      return (res.rowCount ?? 0) > 0;
    });
    if (r) {
      await this.appendEvent(input.runId, input.stageId, "engineering_run.stage_updated", {
        stageId: input.stageId,
        from: input.expectedCapabilityStatus,
        to: input.newCapabilityStatus,
        reason: input.reason ?? null,
        artifactRef: input.artifactRef ?? null,
      });
      return { ok: true, updated: true, reason: "APPLIED" };
    }
    // Lost the CAS.
    const stages = await this.getEngineeringRunStages(input.runId);
    const s = stages.find((x) => x.id === input.stageId);
    if (!s) return { ok: false, updated: false, reason: "STAGE_NOT_FOUND" };
    if (s.capabilityStatus === input.newCapabilityStatus) {
      return { ok: true, updated: false, reason: "IDEMPOTENT" };
    }
    return { ok: false, updated: false, reason: "CAS_LOST" };
  }

  // ---------------- Cancellation ----------------

  async cancelEngineeringRun(runId: string, reason?: string): Promise<{ ok: boolean; reason: string }> {
    const now = Date.now();
    const r = await this.withPg(async (pg) => {
      const res = await pg.query(
        "UPDATE engineering_runs SET current_stage = '__CANCELLED__', updated_at = $1 " +
        "WHERE id = $2 AND current_stage IS DISTINCT FROM '__CANCELLED__' " +
        "RETURNING id",
        [now, runId],
      );
      return (res.rowCount ?? 0) > 0;
    });
    if (!r) {
      const existing = await this.getEngineeringRun(runId);
      if (!existing) return { ok: false, reason: "RUN_NOT_FOUND" };
      return { ok: false, reason: "ALREADY_CANCELLED_OR_TERMINAL" };
    }
    // Persist a flag on the parent execution job (cancellation_requested).
    try {
      await this.store.requestCancellationAsync(runId);
    } catch { /* best-effort; the engineering_run row is authoritative here */ }
    await this.appendEvent(runId, null, "engineering_run.cancel_requested", {
      runId, reason: reason ?? null,
    });
    await this.appendEvent(runId, null, "engineering_run.cancelled", {
      runId, reason: reason ?? null,
    });
    return { ok: true, reason: "CANCELLED" };
  }

  // ---------------- Reconciliation ----------------

  /**
   * Deterministic. Reads durable state, reports inconsistencies, and NEVER
   * resurrects a terminal run. Phase 214 scope: reconcile the metadata layer
   * against the execution_jobs state. Terminal parent implies no active stage.
   */
  async reconcileEngineeringRun(runId: string): Promise<{
    runId: string;
    action: "NOOP" | "RECONCILED" | "INCONSISTENT" | "TERMINAL_SAFE";
    reasons: string[];
  }> {
    const run = await this.getEngineeringRun(runId);
    if (!run) return { runId, action: "INCONSISTENT", reasons: ["RUN_NOT_FOUND"] };
    const stages = await this.getEngineeringRunStages(runId);
    const reasons: string[] = [];

    // Duplicate ordinals.
    const ordSeen = new Set<number>();
    for (const s of stages) {
      if (ordSeen.has(s.ordinal)) reasons.push("DUPLICATE_ORDINAL:" + s.ordinal);
      ordSeen.add(s.ordinal);
    }

    // Parent job state.
    const parent = await this.store.getJobAsync(runId);
    if (!parent) {
      return { runId, action: "INCONSISTENT", reasons: ["PARENT_EXECUTION_JOB_MISSING"] };
    }
    const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTER", "BLOCKED"]);
    if (TERMINAL.has(parent.status)) {
      // Terminal parent: no stage may be in an active status.
      const activeStages = stages.filter((s) => s.capabilityStatus === "AVAILABLE" && !s.completedAt);
      if (activeStages.length > 0) {
        reasons.push("TERMINAL_RUN_HAS_ACTIVE_STAGES:" + activeStages.map((s) => s.stageType).join(","));
        return { runId, action: "INCONSISTENT", reasons };
      }
      return { runId, action: "TERMINAL_SAFE", reasons };
    }

    if (reasons.length === 0) return { runId, action: "NOOP", reasons };
    return { runId, action: "INCONSISTENT", reasons };
  }

  // ---------------- Internals ----------------

  async recordStageExecutionEvent(
    runId: string,
    stageId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.appendEvent(runId, stageId, eventType, payload);
  }

  private async appendEvent(
    runId: string,
    stageId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventId = genId("eevt-");
    const now = Date.now();
    await this.withPg(async (pg) => {
      await pg.query(
        "INSERT INTO engineering_run_events (event_id, run_id, stage_id, event_type, payload, created_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
        [eventId, runId, stageId, eventType, JSON.stringify(payload), now],
      );
    });
  }

  private mapRun(row: any): EngineeringRun {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      objective: row.objective,
      normalizedObjective: row.normalized_objective,
      repository: row.repository,
      sourceRevision: row.source_revision,
      currentStage: row.current_stage,
      revision: Number(row.revision),
      correlationId: row.correlation_id,
      requestedBy: row.requested_by,
      executionContext: row.execution_context,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapStage(row: any): EngineeringRunStage {
    return {
      id: row.id,
      runId: row.run_id,
      stageType: row.stage_type as EngineeringStageType,
      ordinal: Number(row.ordinal),
      capabilityStatus: row.capability_status as CapabilityStatus,
      capabilityReason: row.capability_reason,
      blockedAt: row.blocked_at === null ? null : Number(row.blocked_at),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      artifactRef: row.artifact_ref,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapEvent(row: any): EngineeringRunEvent {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      stageId: row.stage_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: Number(row.created_at),
    };
  }
}
