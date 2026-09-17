// src/core/cicd-reconciliation.service.ts
//
// Phase 132: durable driver for the asynchronous CI lifecycle.
//
// Phase 135: EVERY authoritative mutation is fenced with an atomic SQL CAS
// against the Phase 134 ownership row. A stale worker (lease lost, taken over
// by another instance) that resumes after a delayed provider response cannot
// mutate authoritative reconciliation state. Its UPDATE ... WHERE ... AND
// EXISTS (valid-ownership) reports changes === 0 and the write is rejected
// with a deterministic fencing outcome. The row is left untouched.

import type { CiPipelineEngine, CiContext } from "./cicd";
import type { Actor } from "./services";
import type { CiArtifactReconciliationService, SqliteDb } from "./ci-artifact-reconciliation.service";
import type { FencingContext, OwnershipFailureReason } from "./ci-reconciliation-ownership.service";

/**
 * Phase 135: minimal structural contract this service needs from the Phase
 * 134 ownership record. CiReconciliationOwnershipService satisfies it
 * structurally. The fence (currentFence) is optional so that a Phase 132
 * test harness that does not wire ownership continues to work unfenced.
 */
export interface ReconciliationOwnershipGate {
  ensureOwned(): Promise<{ owned: boolean; reason?: OwnershipFailureReason }>;
  currentFence?(): FencingContext | null;
  workerIdValue?(): string;
  currentLeaseId?(): string | null;
}

export interface EngineLookup {
  get<T>(collection: string, id: string): Promise<T | undefined>;
}

export interface CiPipelineRunLike {
  id: string;
  execution_id: string;
  project_id?: string;
  provider: string;
  repository: string;
  ref: string;
  status: string;
  attempt?: number;
  correlation_id?: string;
  external_run_id?: string;
  workflow_file?: string;
  commit_sha?: string;
  created_at?: number;
  updated_at?: number;
  blocked_reason?: string | null;
  error?: unknown;
}

export interface EmitterLike {
  emit(input: { type: string; source: string; execution_id: string; payload: Record<string, unknown> }): Promise<unknown>;
}
export interface AuditorLike {
  record(input: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result: "allow" | "deny" | "error" | "info";
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface CiReconciliationRow {
  reconciliation_id: string;
  run_id: string;
  execution_id: string;
  project_id: string | null;
  provider_id: string;
  external_run_id: string;
  repository: string;
  commit_sha: string;
  workflow_file: string | null;
  state: "PENDING" | "ARTIFACT_DISCOVERING" | "ARTIFACT_VALIDATING" | "REGISTERED" | "BLOCKED";
  blocked_reason: string | null;
  github_artifact_id: string | null;
  image_repository: string | null;
  image_tag: string | null;
  image_digest: string | null;
  immutable_reference: string | null;
  registered_artifact_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface EnsureReconciliationInput {
  runId: string;
  executionId: string;
  projectId: string | null;
  providerId: string;
  externalRunId: string;
  repository: string;
  commitSha: string;
  workflowFile?: string | null;
}

export interface ReconcileOnceResult {
  state: CiReconciliationRow["state"];
  blockedReason: string | null;
  ciStatus: string | null;
  attempts: number;
  /**
   * Phase 135: true when an authoritative write was rejected because the SQL
   * CAS proved this worker is no longer the current owner. Distinct from
   * CI failure: no state='BLOCKED' write occurred, no CI_TERMINAL reason was
   * fabricated, and the row's durable state is unchanged.
   */
  fenced?: boolean;
  fenceReason?: string;
}

const SYSTEM_ACTOR = "system:ci-reconciliation@nexus.local";
const SOURCE = "CicdReconciliationService";

const FENCE_CLAUSE =
  " AND EXISTS (SELECT 1 FROM ci_reconciliation_worker_ownership " +
  "WHERE ownership_id = ? AND worker_id = ? AND lease_id = ? " +
  "AND state = 'ACTIVE' AND expires_at > ?)";

export class CicdReconciliationService {
  constructor(
    private readonly db: SqliteDb,
    private readonly ciEngine: CiPipelineEngine,
    private readonly engine: EngineLookup,
    private readonly artifactReconciler: CiArtifactReconciliationService,
    private readonly events: EmitterLike,
    private readonly audit: AuditorLike,
    /**
     * Phase 135: optional durable-ownership gate. When supplied, every
     * authoritative write is executed with the SQL CAS fence. When omitted
     * (Phase 132 unit tests), the service behaves exactly as before.
     */
    private readonly ownership?: ReconciliationOwnershipGate,
  ) {}

  private mapRow(r: Record<string, unknown>): CiReconciliationRow {
    return {
      reconciliation_id: String(r.reconciliation_id),
      run_id: String(r.run_id),
      execution_id: String(r.execution_id),
      project_id: (r.project_id as string | null) ?? null,
      provider_id: String(r.provider_id),
      external_run_id: String(r.external_run_id),
      repository: String(r.repository),
      commit_sha: String(r.commit_sha),
      workflow_file: (r.workflow_file as string | null) ?? null,
      state: r.state as CiReconciliationRow["state"],
      blocked_reason: (r.blocked_reason as string | null) ?? null,
      github_artifact_id: (r.github_artifact_id as string | null) ?? null,
      image_repository: (r.image_repository as string | null) ?? null,
      image_tag: (r.image_tag as string | null) ?? null,
      image_digest: (r.image_digest as string | null) ?? null,
      immutable_reference: (r.immutable_reference as string | null) ?? null,
      registered_artifact_id: (r.registered_artifact_id as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
      last_error: (r.last_error as string | null) ?? null,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      completed_at: (r.completed_at as number | null) ?? null,
    };
  }

  byKey(providerId: string, externalRunId: string): CiReconciliationRow | undefined {
    const row = this.db.prepare(
      "SELECT * FROM ci_artifact_reconciliations WHERE provider_id = ? AND external_run_id = ?"
    ).get(providerId, externalRunId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  byRunId(runId: string): CiReconciliationRow | undefined {
    const row = this.db.prepare(
      "SELECT * FROM ci_artifact_reconciliations WHERE run_id = ?"
    ).get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  ensure(input: EnsureReconciliationInput): CiReconciliationRow {
    const existing = this.byKey(input.providerId, input.externalRunId);
    if (existing) return existing;
    const now = Date.now();
    const id = "cir_" + input.runId;
    this.db.prepare(
      "INSERT INTO ci_artifact_reconciliations (" +
      "reconciliation_id, run_id, execution_id, project_id, provider_id, " +
      "external_run_id, repository, commit_sha, workflow_file, state, " +
      "attempts, created_at, updated_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)"
    ).run(
      id, input.runId, input.executionId, input.projectId, input.providerId,
      input.externalRunId, input.repository, input.commitSha, input.workflowFile ?? null,
      now, now,
    );
    const created = this.byRunId(input.runId);
    if (!created) throw new Error("failed to create reconciliation row for run " + input.runId);
    return created;
  }

  listOpen(): CiReconciliationRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM ci_artifact_reconciliations " +
      "WHERE state IN ('PENDING','ARTIFACT_DISCOVERING','ARTIFACT_VALIDATING') " +
      "ORDER BY updated_at ASC"
    ).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Phase 135: atomic fenced UPDATE. Returns { fenced:true } when the SQL CAS
   * proves we are no longer the current owner. Never writes when fenced.
   */
  private runFencedUpdate(
    baseSql: string,
    baseParams: unknown[],
  ): { fenced: boolean; changes: number } {
    const fence = this.ownership?.currentFence?.() ?? null;
    if (!fence) {
      const r = this.db.prepare(baseSql).run(...baseParams) as { changes: number };
      return { fenced: false, changes: r.changes };
    }
    const sql = baseSql + FENCE_CLAUSE;
    const r = this.db.prepare(sql).run(
      ...baseParams,
      fence.ownershipId,
      fence.workerId,
      fence.leaseId,
      fence.now(),
    ) as { changes: number };
    return { fenced: r.changes === 0, changes: r.changes };
  }

  private async emitFenced(runId: string, phase: string): Promise<void> {
    const workerId = this.ownership?.workerIdValue?.() ?? null;
    try {
      await this.events.emit({
        type: "ci.reconciliation.fenced",
        source: SOURCE,
        execution_id: "",
        payload: { run_id: runId, phase, workerId, reason: "ownership-lost" },
      });
    } catch { /* observability is best-effort */ }
  }

  private fencedResult(
    runId: string,
    ciStatus: string | null,
    phase: string,
  ): ReconcileOnceResult {
    void this.emitFenced(runId, phase);
    // Refetch so the reported state is the current durable state, which may
    // have advanced past the snapshot taken at the top of reconcileOnce.
    const fresh = this.byRunId(runId);
    return {
      state: fresh?.state ?? "PENDING",
      blockedReason: fresh?.blocked_reason ?? null,
      ciStatus,
      attempts: fresh?.attempts ?? 0,
      fenced: true,
      fenceReason: "ownership-lost:" + phase,
    };
  }

  async reconcileOnce(runId: string): Promise<ReconcileOnceResult> {
    const row = this.byRunId(runId);
    if (!row) throw new Error("no reconciliation row for run " + runId);
    if (row.state === "REGISTERED" || row.state === "BLOCKED") {
      return { state: row.state, blockedReason: row.blocked_reason, ciStatus: null, attempts: row.attempts };
    }

    const run = await this.engine.get<CiPipelineRunLike>("ci_pipeline_runs", row.run_id);
    if (!run) {
      return this.block(runId, "CI_RUN_NOT_FOUND", row.attempts + 1);
    }

    const ctx: CiContext = {
      actor: { email: SYSTEM_ACTOR } as unknown as Actor,
      project_id: row.project_id ?? "",
      execution_id: row.execution_id,
      attempt: run.attempt ?? 1,
      correlation_id: run.correlation_id ?? ("ci-reconcile-" + row.run_id),
    };

    let polled: CiPipelineRunLike;
    try {
      polled = (await this.ciEngine.pollRun(run as never, ctx)) as unknown as CiPipelineRunLike;
    } catch (e) {
      return this.retry(runId, "POLL_THREW:" + String((e as Error).message ?? e).slice(0, 200), row.attempts + 1);
    }

    const nextAttempts = row.attempts + 1;

    if (polled.status === "FAILED" || polled.status === "CANCELLED" || polled.status === "BLOCKED") {
      return this.block(runId, "CI_TERMINAL_" + polled.status, nextAttempts);
    }

    if (polled.status === "QUEUED" || polled.status === "RUNNING") {
      const r = this.runFencedUpdate(
        "UPDATE ci_artifact_reconciliations SET attempts = ?, updated_at = ? WHERE run_id = ?",
        [nextAttempts, Date.now(), runId],
      );
      if (r.fenced) return this.fencedResult(runId, polled.status, "ATTEMPTS_BUMP");
      return { state: "PENDING", blockedReason: null, ciStatus: polled.status, attempts: nextAttempts };
    }

    if (polled.status === "SUCCEEDED") {
      // Fenced transition PENDING -> ARTIFACT_VALIDATING.
      const r1 = this.runFencedUpdate(
        "UPDATE ci_artifact_reconciliations SET state = 'ARTIFACT_VALIDATING', attempts = ?, updated_at = ? WHERE run_id = ?",
        [nextAttempts, Date.now(), runId],
      );
      if (r1.fenced) return this.fencedResult(runId, "SUCCEEDED", "ARTIFACT_VALIDATING");

      try {
        await this.events.emit({
          type: "ci.reconciliation.succeeded",
          source: SOURCE,
          execution_id: row.execution_id,
          payload: { run_id: row.run_id, external_run_id: row.external_run_id },
        });
      } catch { /* best-effort */ }

      // The artifact reconciler fences its own mutation pair with the same
      // durable ownership row. On fence loss it returns SKIPPED_NO_OWNERSHIP.
      const outcome = await this.artifactReconciler.reconcile({
        runId: row.run_id,
        executionId: row.execution_id,
        projectId: row.project_id,
        providerId: "github-actions",
        externalRunId: row.external_run_id,
        repository: row.repository,
        commitSha: row.commit_sha,
      });

      if (outcome.state === "SKIPPED_NO_OWNERSHIP") {
        return this.fencedResult(runId, "SUCCEEDED", "ARTIFACT_RECONCILE");
      }

      if (outcome.state !== "REGISTERED") {
        return this.block(runId, outcome.reason, nextAttempts + 1, outcome.githubArtifactId);
      }

      // Fenced terminal REGISTERED write.
      const r3 = this.runFencedUpdate(
        "UPDATE ci_artifact_reconciliations SET " +
        "state = 'REGISTERED', " +
        "github_artifact_id = ?, github_artifact_name = ?, " +
        "image_repository = ?, image_tag = ?, image_digest = ?, " +
        "immutable_reference = ?, registered_artifact_id = ?, " +
        "attempts = ?, updated_at = ?, completed_at = ? " +
        "WHERE run_id = ?",
        [
          outcome.githubArtifactId, "nexus-image-digest.json",
          outcome.artifact.image_repository, outcome.artifact.image_tag, outcome.artifact.image_digest,
          outcome.artifact.immutable_reference, outcome.nexusArtifactId,
          nextAttempts, Date.now(), Date.now(), runId,
        ],
      );
      if (r3.fenced) return this.fencedResult(runId, "SUCCEEDED", "REGISTERED");

      try {
        await this.events.emit({
          type: "ci.image_digest.bound",
          source: SOURCE,
          execution_id: row.execution_id,
          payload: {
            run_id: row.run_id,
            external_run_id: row.external_run_id,
            image_digest: outcome.artifact.image_digest,
            immutable_reference: outcome.artifact.immutable_reference,
          },
        });
      } catch { /* best-effort */ }

      try {
        await this.audit.record({
          actor: SYSTEM_ACTOR,
          action: "ci.digest.reconciled",
          resource_type: "ci_reconciliation",
          resource_id: row.run_id,
          result: "allow",
          metadata: { image_digest: outcome.artifact.image_digest, binding_id: outcome.bindingId },
        });
      } catch { /* best-effort */ }

      return { state: "REGISTERED", blockedReason: null, ciStatus: "SUCCEEDED", attempts: nextAttempts };
    }

    return this.block(runId, "UNMAPPED_CI_STATUS:" + polled.status, nextAttempts);
  }

  async reconcileOpen(): Promise<Array<{ runId: string; result: ReconcileOnceResult }>> {
    const open = this.listOpen();
    const out: Array<{ runId: string; result: ReconcileOnceResult }> = [];
    for (const row of open) {
      try {
        const result = await this.reconcileOnce(row.run_id);
        out.push({ runId: row.run_id, result });
      } catch (e) {
        out.push({
          runId: row.run_id,
          result: {
            state: "BLOCKED",
            blockedReason: "RECONCILE_THREW:" + String((e as Error).message ?? e).slice(0, 200),
            ciStatus: null,
            attempts: row.attempts + 1,
          },
        });
      }
    }
    return out;
  }

  private async block(runId: string, reason: string, attempts: number, githubArtifactId?: string): Promise<ReconcileOnceResult> {
    const row = this.byRunId(runId);
    const now = Date.now();
    const r = this.runFencedUpdate(
      "UPDATE ci_artifact_reconciliations SET " +
      "state = 'BLOCKED', blocked_reason = ?, last_error = ?, " +
      "github_artifact_id = COALESCE(?, github_artifact_id), " +
      "attempts = ?, updated_at = ?, completed_at = ? " +
      "WHERE run_id = ?",
      [reason, reason, githubArtifactId ?? null, attempts, now, now, runId],
    );

    // Phase 135 section 7: a fence failure is NOT a CI failure. Do not write
    // BLOCKED and do not claim the remote CI run failed. Return the fenced
    // outcome so the caller can observe a distinct machine-readable state.
    if (r.fenced) {
      return {
        state: row?.state ?? "PENDING",
        blockedReason: null,
        ciStatus: null,
        attempts: row?.attempts ?? attempts - 1,
        fenced: true,
        fenceReason: "ownership-lost:BLOCK_WRITE:" + reason,
      };
    }

    try {
      await this.events.emit({
        type: "ci.reconciliation.blocked",
        source: SOURCE,
        execution_id: "",
        payload: { run_id: runId, reason },
      });
    } catch { /* best-effort */ }

    return { state: "BLOCKED", blockedReason: reason, ciStatus: null, attempts };
  }

  private async retry(runId: string, reason: string, attempts: number): Promise<ReconcileOnceResult> {
    const row = this.byRunId(runId);
    const r = this.runFencedUpdate(
      "UPDATE ci_artifact_reconciliations SET last_error = ?, attempts = ?, updated_at = ? WHERE run_id = ?",
      [reason, attempts, Date.now(), runId],
    );
    if (r.fenced) {
      return {
        state: row?.state ?? "PENDING",
        blockedReason: null,
        ciStatus: null,
        attempts: row?.attempts ?? attempts - 1,
        fenced: true,
        fenceReason: "ownership-lost:RETRY_WRITE:" + reason,
      };
    }

    try {
      await this.events.emit({
        type: "ci.reconciliation.retry",
        source: SOURCE,
        execution_id: "",
        payload: { run_id: runId, reason, attempts },
      });
    } catch { /* best-effort */ }

    return { state: "PENDING", blockedReason: null, ciStatus: null, attempts };
  }
}