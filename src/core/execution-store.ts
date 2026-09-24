import { sha256 } from "./sha256";
import { NexusEngine, AsyncNexusEngine } from "./db";
import { ExecutionRecoveryOperationStore, AsyncExecutionRecoveryOperationStore } from "./execution-recovery-operation-store";
import { RemoteDispatchRecord, RemoteExecutionResult } from "./execution-models";
import {
  ExecutionJob,
  ExecutionAttempt,
  ExecutionAttemptStatus,
  ExecutionWorker,
  ExecutionLease,
  ArtifactRecord,
  ReleaseRecord,
  DeploymentRecord,
  ApprovalRequest,
  ExecutionEvent,
  ExecutionOutcomeProvenance,
} from "./execution-models";
import {
  verifyProvenanceEvidenceHash,
  validateProvenanceAgainstAttempt,
  validateRetryLineage,
  type ProvenanceQueryResult,
  type ProvenanceIntegrityFailure,
  type ProvenanceVerificationResult,
  type RetryLineageResult,
  type RetryLineageStep,
} from "./audit-provenance-integrity";
/* -------- Phase 138: durable production execution authorization -------- */

export interface StoredProductionAuthorization {
  authorizationId: string;
  releaseId: string;
  artifactId: string;
  artifactDigest: string;
  commitSha: string;
  environment: string;
  securityDecisionId: string;
  approvalId: string;
  executionId: string | null;
  projectId: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageId: string | null;
  containerName: string | null;
  containerPort: number | null;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedByAttemptId: string | null;
  revokedAt: string | null;
}
/* -------- Phase 103: durable release deployment intent -------- */

export type ReleaseIntentStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "DEPLOYMENT_INTENT_CREATED"
  | "DEPLOYING"
  | "HEALTH_CHECKING"
  | "SMOKE_TESTING"
  | "VERIFICATION_FAILED"
  | "ROLLING_BACK"
  | "KNOWN_GOOD"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "RECOVERY_REQUIRED"
  | "UNKNOWN";

export interface ReleaseDeploymentIntent {
  intentKey: string;
  releaseId: string;
  executionId: string;
  attemptId?: string | null;
  artifactId: string;
  artifactDigest: string;
  commitSha: string;
  environment: string;
  projectId?: string | null;
  imageRepository: string;
  imageTag: string;
  imageId: string | null;
  imageDigest: string;
  containerName: string;
  containerPort: number;
  // Phase 138: provider execution identity and result.
  provider?: string | null;
  providerStatus?: string | null;
  providerDeploymentId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  reconciledAt?: number | null;
  cancelRequestedAt?: number | null;
  cancelAcknowledgedAt?: number | null;
    // Phase 119: discriminator + rollback linkage.
    intentKind?: "DEPLOY" | "ROLLBACK";
    rollbackTargetReleaseId?: string | null;
    rollbackJobId?: string | null;
  // Phase 175: durable retry bookkeeping.
  recoveryAttempts?: number;
  nextRetryAt?: number | null;
  lastFailureClass?: string | null;
  // Phase 176: durable reconciliation provenance (JSON envelope) written on
  // authoritative terminal decisions. Never a decision input; audit only.
  reconciliationEvidence?: string | null;
  // Phase 177: durable recovery decision journal (JSON envelope).
  // Written atomically with the transition that produced it; never a
  // decision input on its own -- a durable trace of the control loop.
  lastRecoveryDecision?: string | null;
  lastRecoveryDecisionAt?: number | null;
  status: ReleaseIntentStatus;
  deploymentId: string | null;
  failureReason: string | null;
  recoveryReason: string | null;
  leasedBy: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
// ---------- Phase 127: authoritative durable transitions ----------

export type TransitionActor = "worker" | "recovery" | "system";

export interface TransitionInput {
  jobId: string;
  actor: TransitionActor;
  expectedStatus: ExecutionJob["status"];
  newStatus: ExecutionJob["status"];
  workerId?: string;
  leaseId?: string;
  reason?: string;
  now?: number;
  patch?: Partial<Pick<ExecutionJob,
    | "currentLeaseId" | "retryPolicy" | "timeoutMs"
    | "lastAttemptAt" | "nextAttemptAt"
    | "cancellationRequested" | "cancellationAcknowledged"
    | "payload">>;
}

export type TransitionResult =
  | { ok: true;  applied: true;  status: ExecutionJob["status"]; idempotent: false }
  | { ok: true;  applied: false; status: ExecutionJob["status"]; idempotent: true  }
  | { ok: false;
      reason: "WORKER_OWNERSHIP_LOST" | "STATE_MISMATCH" | "TERMINAL_STATE" | "JOB_NOT_FOUND";
      currentStatus: ExecutionJob["status"] | null };
export type AtomicClaimRejectReason =
  | "NOT_QUEUED"
  | "CANCELLED"
  | "ALREADY_LEASED"
  | "LEASE_CONFLICT"
  | "TRANSITION_FAILED";

class AtomicClaimReject extends Error {
  constructor(public readonly reason: AtomicClaimRejectReason) {
    super("atomic claim rejected: " + reason);
    this.name = "AtomicClaimReject";
  }
}
export class ExecutionStore {
  readonly recoveryOps: ExecutionRecoveryOperationStore;
  readonly recoveryOpsAsync?: AsyncExecutionRecoveryOperationStore;
  /** @internal Phase 142 Ã¢â‚¬â€ test-only injection hook. No-op in production. */
  public __testPhase142Hook?: (stage: "afterLeaseInsert" | "afterJobUpdate") => void;
  /** @internal Phase 143 - test-only injection hook. No-op in production. */
  public __testPhase143Hook?: (stage: "afterJobUpdate" | "afterObligation") => void;
  /**
   * Phase 183b: asyncDb is the future authoritative contract for shared mode.
   * Unused by every method today -- existing methods remain synchronous and
   * use this.db. Phase 183c+ migrates methods one bounded slice at a time to
   * asyncDb when present, falling back to the sync path in SQLite mode.
   */
  constructor(
    private db: NexusEngine,
    private asyncDb?: AsyncNexusEngine,
  ) { this.recoveryOps = new ExecutionRecoveryOperationStore(this.db);
    this.recoveryOpsAsync = this.asyncDb ? new AsyncExecutionRecoveryOperationStore(this.asyncDb) : undefined; }

  // ---------- Jobs ----------
  createJob(job: ExecutionJob): void {
    this.db.prepare(`
      INSERT INTO execution_jobs (
        id, idempotency_key, job_type, payload, status, retry_policy,
        timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at,
        current_lease_id, cancellation_requested, cancellation_acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.idempotencyKey,
      job.jobType,
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      job.createdAt,
      job.updatedAt,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0
    );
  }

  getJob(id: string): ExecutionJob | undefined {
    const row = this.db.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(id);
    return row ? this.mapJob(row) : undefined;
  }

  getJobByIdempotencyKey(key: string): ExecutionJob | undefined {
    const row = this.db.prepare("SELECT * FROM execution_jobs WHERE idempotency_key = ?").get(key);
    return row ? this.mapJob(row) : undefined;
  }

  updateJob(job: ExecutionJob): void {
    this.db.prepare(`
      UPDATE execution_jobs SET
        payload = ?, status = ?, retry_policy = ?, timeout_ms = ?,
        updated_at = ?, last_attempt_at = ?, next_attempt_at = ?,
        current_lease_id = ?, cancellation_requested = ?, cancellation_acknowledged = ?
      WHERE id = ?
    `).run(
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      job.updatedAt,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.id
    );
  }

  /**
   * Phase 126: ownership-aware mutation.  Atomically verifies that the
   * supplied leaseId is currently ACTIVE, unexpired, and owned by workerId
   * before committing the job update.  A stale worker's write fails
   * deterministically with WORKER_OWNERSHIP_LOST and mutates nothing.
   */
  updateJobAsOwner(
    job: ExecutionJob,
    workerId: string,
    leaseId: string,
    now: number = Date.now()
  ): { updated: boolean; reason?: "WORKER_OWNERSHIP_LOST" } {
    const result = this.db.prepare(`
      UPDATE execution_jobs SET
        payload = ?, status = ?, retry_policy = ?, timeout_ms = ?,
        updated_at = ?, last_attempt_at = ?, next_attempt_at = ?,
        current_lease_id = ?, cancellation_requested = ?, cancellation_acknowledged = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND status = 'ACTIVE' AND expires_at > ?
        )
    `).run(
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      now,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.id,
      leaseId,
      workerId,
      now
    );
    if (result.changes === 0) {
      return { updated: false, reason: "WORKER_OWNERSHIP_LOST" };
    }
    return { updated: true };
  }

  /**
   * Phase 127: single authoritative durable transition.
   * State-machine legality + actor-role policy live in ExecutionEngine.applyTransition.
   * This method is the DB-level concurrency boundary: expected-state CAS + ownership.
   */
  transitionExecution(input: TransitionInput): TransitionResult {
    const now = input.now ?? Date.now();
    const before = this.getJob(input.jobId);
    if (!before) return { ok: false, reason: "JOB_NOT_FOUND", currentStatus: null };

    // Phase 127: worker fencing MUST precede the idempotency shortcut.
    // Otherwise a stale worker whose job already happens to be in newStatus
    // would receive "idempotent success" without proving lease ownership.
    if (input.actor === "worker") {
      if (!input.leaseId || !input.workerId) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus: before.status };
      }
      const owned = this.db.prepare(`
        SELECT 1 FROM execution_leases
        WHERE lease_id = ? AND worker_id = ? AND job_id = ?
          AND status = 'ACTIVE' AND expires_at > ?
      `).get(input.leaseId, input.workerId, input.jobId, now);
      if (!owned) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus: before.status };
      }
    }

    // Idempotent duplicate (safe now that ownership has been verified).
    if (before.status === input.newStatus) {
      return { ok: true, applied: false, status: before.status, idempotent: true };
    }

    // Terminal-state protection.
    const TERMINAL: ExecutionJob["status"][] = ["SUCCEEDED", "CANCELLED", "DEAD_LETTER", "BLOCKED"];
    if (TERMINAL.includes(input.expectedStatus) && input.expectedStatus !== input.newStatus) {
      return { ok: false, reason: "TERMINAL_STATE", currentStatus: before.status };
    }

    const useOwner = input.actor === "worker" ? 1 : 0;
    const p = input.patch ?? {};

    // Atomic UPDATE + event, using the repository's existing SQLite
    // transaction compatibility pattern (raw better-sqlite3 vs SQLiteEngine).
    let updateResult: any = null;

    const run = (): any => {
      const r = this.db.prepare(`
        UPDATE execution_jobs SET
          status = ?, updated_at = ?,
          current_lease_id          = COALESCE(?, current_lease_id),
          retry_policy              = COALESCE(?, retry_policy),
          timeout_ms                = COALESCE(?, timeout_ms),
          last_attempt_at           = COALESCE(?, last_attempt_at),
          next_attempt_at           = COALESCE(?, next_attempt_at),
          cancellation_requested    = COALESCE(?, cancellation_requested),
          cancellation_acknowledged = COALESCE(?, cancellation_acknowledged)
        WHERE id = ? AND status = ?
          AND (
            ? = 0
            OR EXISTS (
              SELECT 1 FROM execution_leases
              WHERE lease_id = ? AND worker_id = ? AND job_id = ?
                AND status = 'ACTIVE' AND expires_at > ?
            )
          )
      `).run(
        input.newStatus, now,
        p.currentLeaseId === undefined ? null : (p.currentLeaseId ?? null),
        p.retryPolicy === undefined ? null : (p.retryPolicy ? JSON.stringify(p.retryPolicy) : null),
        p.timeoutMs === undefined ? null : (p.timeoutMs ?? null),
        p.lastAttemptAt === undefined ? null : (p.lastAttemptAt ?? null),
        p.nextAttemptAt === undefined ? null : (p.nextAttemptAt ?? null),
        p.cancellationRequested === undefined ? null : (p.cancellationRequested ? 1 : 0),
        p.cancellationAcknowledged === undefined ? null : (p.cancellationAcknowledged ? 1 : 0),
        input.jobId, input.expectedStatus,
        useOwner, input.leaseId ?? null, input.workerId ?? null, input.jobId, now
      );

      if (r.changes > 0) {
        // Event insert is part of durable transition integrity: a failure
        // here aborts the transaction and rolls back the state change.
        this.addEvent({
          eventId: `evt_${input.jobId}_${now}_${Math.random().toString(36).slice(2, 10)}`,
          jobId: input.jobId,
          eventType: `execution.transition.${input.newStatus.toLowerCase()}`,
          payload: {
            from: input.expectedStatus, to: input.newStatus, actor: input.actor,
            reason: input.reason ?? null,
            workerId: input.workerId ?? null, leaseId: input.leaseId ?? null,
          },
          createdAt: now,
        });
      }

      updateResult = r;
      return r;
    };

    let txThrew = false;
    try {
      const maybeTx: any = (this.db as any).transaction(run);
      if (typeof maybeTx === "function") {
        maybeTx();
      }
      // else: SQLiteEngine executed fn eagerly; closure already set updateResult.
    } catch {
      txThrew = true;
      updateResult = null;
    }

    if (txThrew) {
      // Event insertion failed; state rollback preserved consistency but the
      // transition itself did not commit.  Reported as STATE_MISMATCH
      // because TransitionResult has no dedicated EVENT_FAILED reason.
      const cur = this.getJob(input.jobId);
      return { ok: false, reason: "STATE_MISMATCH", currentStatus: cur?.status ?? null };
    }

    if (!updateResult || updateResult.changes === 0) {
      const cur = this.getJob(input.jobId);
      const currentStatus = cur?.status ?? null;
      if (currentStatus === input.newStatus) {
        return { ok: true, applied: false, status: currentStatus, idempotent: true };
      }
      if (input.actor === "worker" && currentStatus === input.expectedStatus) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus };
      }
      return { ok: false, reason: "STATE_MISMATCH", currentStatus };
    }

    return { ok: true, applied: true, status: input.newStatus, idempotent: false };
  }
  /** Phase 127 STEP 8: flag-only cancellation; never writes status. */
  requestCancellation(jobId: string, now: number = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE execution_jobs SET cancellation_requested = 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER', 'BLOCKED')
    `).run(now, jobId);
    return result.changes > 0;
  }

  /**
   * Phase 126: durable ownership-loss obligation.
   * Idempotent per (job_id, lease_id): repeated detection is a no-op.
   */
  writeOwnershipObligation(input: {
    jobId: string;
    leaseId: string;
    workerId: string;
    reason: string;
    now?: number;
  }): { obligationId: string; created: boolean } {
    const now = input.now ?? Date.now();
    const obligationId = `oblig_${input.jobId}_${input.leaseId}`;
    try {
      this.db.prepare(`
        INSERT INTO execution_ownership_obligations (
          obligation_id, job_id, lease_id, worker_id, reason, state, created_at
        ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
      `).run(obligationId, input.jobId, input.leaseId, input.workerId, input.reason, now);
      return { obligationId, created: true };
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(err.message)) {
        const existing = this.db.prepare(
          `SELECT obligation_id FROM execution_ownership_obligations WHERE job_id = ? AND lease_id = ?`
        ).get(input.jobId, input.leaseId) as { obligation_id: string } | undefined;
        return { obligationId: existing?.obligation_id ?? obligationId, created: false };
      }
      throw err;
    }
  }

  // ---------- Phase 184: async ownership obligation ----------
  // Mirrors writeOwnershipObligation with ON CONFLICT DO NOTHING, matching
  // the idempotency semantics already used in recoverJobAtomicAsync.
  // Routes through asyncDb only; never falls back to SQLite.
  async writeOwnershipObligationAsync(input: {
    jobId: string;
    leaseId: string;
    workerId: string;
    reason: string;
    now?: number;
  }): Promise<{ obligationId: string; created: boolean }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const obligationId = `oblig_${input.jobId}_${input.leaseId}`;

    const inserted = await engine.prepareAsync(`
      INSERT INTO execution_ownership_obligations (
        obligation_id, job_id, lease_id, worker_id, reason, state, created_at
      ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
      ON CONFLICT (job_id, lease_id) DO NOTHING
      RETURNING obligation_id
    `).all<{ obligation_id: string }>(
      obligationId, input.jobId, input.leaseId, input.workerId, input.reason, now,
    );

    if (inserted.length > 0) {
      return { obligationId: inserted[0].obligation_id, created: true };
    }
    const winner = await engine.prepareAsync(
      "SELECT obligation_id FROM execution_ownership_obligations WHERE job_id = ? AND lease_id = ?",
    ).get<{ obligation_id: string }>(input.jobId, input.leaseId);
    return { obligationId: winner?.obligation_id ?? obligationId, created: false };
  }
  resolveOwnershipObligation(obligationId: string, resolution: string, now: number = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE execution_ownership_obligations
      SET state = 'RESOLVED', resolved_at = ?, resolution = ?
      WHERE obligation_id = ? AND state = 'OPEN'
    `).run(now, resolution, obligationId);
    return result.changes > 0;
  }

  listOpenOwnershipObligations(): Array<{
    obligationId: string; jobId: string; leaseId: string; workerId: string;
    reason: string; createdAt: number;
  }> {
    const rows = this.db.prepare(
      `SELECT * FROM execution_ownership_obligations WHERE state = 'OPEN' ORDER BY created_at ASC`
    ).all() as any[];
    return rows.map((r) => ({
      obligationId: r.obligation_id,
      jobId: r.job_id,
      leaseId: r.lease_id,
      workerId: r.worker_id,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /**
   * Phase 126: atomic stale-recovery transition.
   *
   * Recovers a job from `expectedStatus` to `newStatus` ONLY IF the job is
   * still in `expectedStatus` AND its current_lease_id is exactly
   * `expectedLeaseId`.  If a new worker has taken over between the caller's
   * read and this write, the WHERE clause matches zero rows and nothing is
   * mutated.
   *
   * Returns true if the transition was applied, false if the job was
   * concurrently re-owned or otherwise changed state.
   */
  recoverJobToStatus(
    jobId: string,
    expectedStatus: string,
    newStatus: string,
    expectedLeaseId: string | null,
    patch: { nextAttemptAt?: number | null; now?: number } = {}
  ): boolean {
    const now = patch.now ?? Date.now();
    const result = this.db.prepare(`
      UPDATE execution_jobs SET
        status = ?, updated_at = ?, next_attempt_at = ?, current_lease_id = NULL
      WHERE id = ?
        AND status = ?
        AND (
          (? IS NULL AND current_lease_id IS NULL)
          OR current_lease_id = ?
        )
    `).run(
      newStatus,
      now,
      patch.nextAttemptAt ?? null,
      jobId,
      expectedStatus,
      expectedLeaseId,
      expectedLeaseId
    );
    return result.changes > 0;
  }

  /**
   * Phase 143: atomic stale-execution recovery.
   *
   * One SQLite transaction:
   *   1. CAS UPDATE execution_jobs (fenced on status + expected lease id)
   *   2. optional INSERT into execution_ownership_obligations
   *   3. INSERT durable recovery event into execution_events
   *
   * The CAS UPDATE is the sole authority. If it affects 0 rows (job moved on,
   * lease changed), nothing is written and { ok: false } is returned. If any
   * step throws, the whole transaction rolls back. Audit remains fire-and-
   * forget per existing architecture and is explicitly NOT part of this
   * transaction (the current audit path is not durable-execution-scoped).
   */
  recoverJobAtomic(input: {
    jobId: string;
    expectedStatus: string;
    newStatus: string;
    expectedLeaseId: string | null;
    patch?: { nextAttemptAt?: number | null };
    event: { eventType: string; payload: Record<string, unknown> };
    obligation?: { leaseId: string; workerId: string; reason: string };
  }): { ok: boolean; obligationId?: string; obligationCreated?: boolean } {
    const now = Date.now();
    let obligationId: string | undefined;
    let obligationCreated: boolean | undefined;

    const run = (): number => {
      const result = this.db.prepare(`
        UPDATE execution_jobs SET
          status = ?, updated_at = ?, next_attempt_at = ?, current_lease_id = NULL
        WHERE id = ?
          AND status = ?
          AND (
            (? IS NULL AND current_lease_id IS NULL)
            OR current_lease_id = ?
          )
      `).run(
        input.newStatus,
        now,
        input.patch?.nextAttemptAt ?? null,
        input.jobId,
        input.expectedStatus,
        input.expectedLeaseId,
        input.expectedLeaseId,
      );

      if ((result.changes ?? 0) === 0) return 0;

      if (typeof this.__testPhase143Hook === "function") {
        this.__testPhase143Hook("afterJobUpdate");
      }

      if (input.obligation) {
        const ob = this.writeOwnershipObligation({
          jobId: input.jobId,
          leaseId: input.obligation.leaseId,
          workerId: input.obligation.workerId,
          reason: input.obligation.reason,
          now,
        });
        obligationId = ob.obligationId;
        obligationCreated = ob.created;
      }

      if (typeof this.__testPhase143Hook === "function") {
        this.__testPhase143Hook("afterObligation");
      }

      this.addEvent({
        eventId: "evt_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 10),
        jobId: input.jobId,
        eventType: input.event.eventType,
        payload: input.event.payload,
        createdAt: now,
      });

      return result.changes;
    };

    let changes = 0;
    const runCapture = (): void => { changes = run(); };
    const maybeTx: any = (this.db as any).transaction(runCapture);
    if (typeof maybeTx === "function") maybeTx();

    return changes > 0 ? { ok: true, obligationId, obligationCreated } : { ok: false };
  }
  listJobsByStatus(status: string): ExecutionJob[] {
    return this.db.prepare("SELECT * FROM execution_jobs WHERE status = ?").all(status).map(this.mapJob);
  }

  listJobsDueForRetry(now: number): ExecutionJob[] {
    return this.db.prepare(
      "SELECT * FROM execution_jobs WHERE status = 'RETRY_SCHEDULED' AND next_attempt_at <= ?"
    ).all(now).map(this.mapJob);
  }

  // ============================================================
  // Phase 183b: async persistence methods for shared mode.
  //
  // Each mirrors its synchronous sibling exactly -- same SQL, same return
  // shape, same semantics -- but routes through this.asyncDb. Async methods
  // throw if asyncDb is undefined; never silently fall back to sync SQLite.
  //
  // SQL uses `?` placeholders; PgAsyncEngine rewrites to `$N`.
  // CAST(? AS TEXT/INTEGER) is used where Postgres cannot infer the type
  // from context (bare `? IS NULL` and `? = 0`).
  // ============================================================

  /** Phase 183b: true when an async backend is wired (shared mode). */
  hasAsyncBackend(): boolean {
    return this.asyncDb !== undefined;
  }

  private requireAsyncDb(): AsyncNexusEngine {
    if (!this.asyncDb) {
      throw new Error(
        "ExecutionStore async method requires asyncDb (NEXUS_PERSISTENCE_MODE=shared)",
      );
    }
    return this.asyncDb;
  }

  private async addEventOnEngine(engine: AsyncNexusEngine, event: ExecutionEvent): Promise<void> {
    await engine.prepareAsync(`
      INSERT INTO execution_events (event_id, job_id, deployment_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.jobId,
      event.deploymentId ?? null,
      event.eventType,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt,
    );
  }

  async addEventAsync(event: ExecutionEvent): Promise<void> {
    const engine = this.requireAsyncDb();
    await this.addEventOnEngine(engine, event);
  }

  async createJobAsync(job: ExecutionJob): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      INSERT INTO execution_jobs (
        id, idempotency_key, job_type, payload, status, retry_policy,
        timeout_ms, created_at, updated_at, last_attempt_at, next_attempt_at,
        current_lease_id, cancellation_requested, cancellation_acknowledged, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.idempotencyKey,
      job.jobType,
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      job.createdAt,
      job.updatedAt,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.priority ?? 2,
    );
  }

  async getJobAsync(id: string): Promise<ExecutionJob | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync("SELECT * FROM execution_jobs WHERE id = ?").get<any>(id);
    return row ? this.mapJob(row) : undefined;
  }

  async getJobByIdempotencyKeyAsync(key: string): Promise<ExecutionJob | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync("SELECT * FROM execution_jobs WHERE idempotency_key = ?").get<any>(key);
    return row ? this.mapJob(row) : undefined;
  }

  async updateJobAsync(job: ExecutionJob): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      UPDATE execution_jobs SET
        payload = ?, status = ?, retry_policy = ?, timeout_ms = ?,
        updated_at = ?, last_attempt_at = ?, next_attempt_at = ?,
        current_lease_id = ?, cancellation_requested = ?, cancellation_acknowledged = ?
      WHERE id = ?
    `).run(
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      job.updatedAt,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.id,
    );
  }

  async updateJobAsOwnerAsync(
    job: ExecutionJob,
    workerId: string,
    leaseId: string,
    now: number = Date.now(),
  ): Promise<{ updated: boolean; reason?: "WORKER_OWNERSHIP_LOST" }> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE execution_jobs SET
        payload = ?, status = ?, retry_policy = ?, timeout_ms = ?,
        updated_at = ?, last_attempt_at = ?, next_attempt_at = ?,
        current_lease_id = ?, cancellation_requested = ?, cancellation_acknowledged = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND status = 'ACTIVE' AND expires_at > ?
        )
    `).run(
      job.payload ? JSON.stringify(job.payload) : null,
      job.status,
      job.retryPolicy ? JSON.stringify(job.retryPolicy) : null,
      job.timeoutMs ?? null,
      now,
      job.lastAttemptAt ?? null,
      job.nextAttemptAt ?? null,
      job.currentLeaseId ?? null,
      job.cancellationRequested ? 1 : 0,
      job.cancellationAcknowledged ? 1 : 0,
      job.id,
      leaseId,
      workerId,
      now,
    );
    if (r.changes === 0) return { updated: false, reason: "WORKER_OWNERSHIP_LOST" };
    return { updated: true };
  }

  async requestCancellationAsync(jobId: string, now: number = Date.now()): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE execution_jobs SET cancellation_requested = 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER', 'BLOCKED')
    `).run(now, jobId);
    return r.changes > 0;
  }

  async listJobsByStatusAsync(status: string): Promise<ExecutionJob[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync("SELECT * FROM execution_jobs WHERE status = ?").all<any>(status);
    return rows.map((r) => this.mapJob(r));
  }

  async listJobsDueForRetryAsync(now: number): Promise<ExecutionJob[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_jobs WHERE status = 'RETRY_SCHEDULED' AND next_attempt_at <= ?",
    ).all<any>(now);
    return rows.map((r) => this.mapJob(r));
  }

  async recoverJobToStatusAsync(
    jobId: string,
    expectedStatus: string,
    newStatus: string,
    expectedLeaseId: string | null,
    patch: { nextAttemptAt?: number | null; now?: number } = {},
  ): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const now = patch.now ?? Date.now();
    const r = await engine.prepareAsync(`
      UPDATE execution_jobs SET
        status = ?, updated_at = ?, next_attempt_at = ?, current_lease_id = NULL
      WHERE id = ?
        AND status = ?
        AND (
          (CAST(? AS TEXT) IS NULL AND current_lease_id IS NULL)
          OR current_lease_id = CAST(? AS TEXT)
        )
    `).run(
      newStatus,
      now,
      patch.nextAttemptAt ?? null,
      jobId,
      expectedStatus,
      expectedLeaseId,
      expectedLeaseId,
    );
    return r.changes > 0;
  }

  async recoverJobAtomicAsync(input: {
    jobId: string;
    expectedStatus: string;
    newStatus: string;
    expectedLeaseId: string | null;
    patch?: { nextAttemptAt?: number | null };
    event: { eventType: string; payload: Record<string, unknown> };
    obligation?: { leaseId: string; workerId: string; reason: string };
  }): Promise<{ ok: boolean; obligationId?: string; obligationCreated?: boolean }> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    let obligationId: string | undefined;
    let obligationCreated: boolean | undefined;
    let changes = 0;

    await engine.transactionAsync(async (tx) => {
      const r = await tx.prepareAsync(`
        UPDATE execution_jobs SET
          status = ?, updated_at = ?, next_attempt_at = ?, current_lease_id = NULL
        WHERE id = ?
          AND status = ?
          AND (
            (CAST(? AS TEXT) IS NULL AND current_lease_id IS NULL)
            OR current_lease_id = CAST(? AS TEXT)
          )
      `).run(
        input.newStatus,
        now,
        input.patch?.nextAttemptAt ?? null,
        input.jobId,
        input.expectedStatus,
        input.expectedLeaseId,
        input.expectedLeaseId,
      );

      changes = r.changes;
      if (changes === 0) return;

      if (typeof (this as any).__testPhase143Hook === "function") {
        (this as any).__testPhase143Hook("afterJobUpdate");
      }

      if (input.obligation) {
        const candidateId = `oblig_${input.jobId}_${input.obligation.leaseId}`;
        const inserted = await tx.prepareAsync(`
          INSERT INTO execution_ownership_obligations (
            obligation_id, job_id, lease_id, worker_id, reason, state, created_at
          ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
          ON CONFLICT (job_id, lease_id) DO NOTHING
          RETURNING obligation_id
        `).all<{ obligation_id: string }>(
          candidateId,
          input.jobId,
          input.obligation.leaseId,
          input.obligation.workerId,
          input.obligation.reason,
          now,
        );
        if (inserted.length > 0) {
          obligationId = inserted[0].obligation_id;
          obligationCreated = true;
        } else {
          const winner = await tx.prepareAsync(
            "SELECT obligation_id FROM execution_ownership_obligations WHERE job_id = ? AND lease_id = ?",
          ).get<{ obligation_id: string }>(input.jobId, input.obligation.leaseId);
          obligationId = winner?.obligation_id ?? candidateId;
          obligationCreated = false;
        }
      }

      if (typeof (this as any).__testPhase143Hook === "function") {
        (this as any).__testPhase143Hook("afterObligation");
      }

      await this.addEventOnEngine(tx, {
        eventId: "evt_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 10),
        jobId: input.jobId,
        eventType: input.event.eventType,
        payload: input.event.payload,
        createdAt: now,
      } as ExecutionEvent);
    });

    return changes > 0 ? { ok: true, obligationId, obligationCreated } : { ok: false };
  }

  async transitionExecutionAsync(input: TransitionInput): Promise<TransitionResult> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const before = await this.getJobAsync(input.jobId);
    if (!before) return { ok: false, reason: "JOB_NOT_FOUND", currentStatus: null };

    if (input.actor === "worker") {
      if (!input.leaseId || !input.workerId) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus: before.status };
      }
      const owned = await engine.prepareAsync(`
        SELECT 1 FROM execution_leases
        WHERE lease_id = ? AND worker_id = ? AND job_id = ?
          AND status = 'ACTIVE' AND expires_at > ?
      `).get(input.leaseId, input.workerId, input.jobId, now);
      if (!owned) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus: before.status };
      }
    }

    if (before.status === input.newStatus) {
      return { ok: true, applied: false, status: before.status, idempotent: true };
    }

    const TERMINAL: ExecutionJob["status"][] = ["SUCCEEDED", "CANCELLED", "DEAD_LETTER", "BLOCKED"];
    if (TERMINAL.includes(input.expectedStatus) && input.expectedStatus !== input.newStatus) {
      return { ok: false, reason: "TERMINAL_STATE", currentStatus: before.status };
    }

    const useOwner = input.actor === "worker" ? 1 : 0;
    const p = input.patch ?? {};
    let changes = 0;
    let txThrew = false;

    try {
      await engine.transactionAsync(async (tx) => {
        const r = await tx.prepareAsync(`
          UPDATE execution_jobs SET
            status = ?, updated_at = ?,
            current_lease_id          = COALESCE(?, current_lease_id),
            retry_policy              = COALESCE(?, retry_policy),
            timeout_ms                = COALESCE(?, timeout_ms),
            last_attempt_at           = COALESCE(?, last_attempt_at),
            next_attempt_at           = COALESCE(?, next_attempt_at),
            cancellation_requested    = COALESCE(?, cancellation_requested),
            cancellation_acknowledged = COALESCE(?, cancellation_acknowledged)
          WHERE id = ? AND status = ?
            AND (
              CAST(? AS INTEGER) = 0
              OR EXISTS (
                SELECT 1 FROM execution_leases
                WHERE lease_id = ? AND worker_id = ? AND job_id = ?
                  AND status = 'ACTIVE' AND expires_at > ?
              )
            )
        `).run(
          input.newStatus, now,
          p.currentLeaseId === undefined ? null : (p.currentLeaseId ?? null),
          p.retryPolicy === undefined ? null : (p.retryPolicy ? JSON.stringify(p.retryPolicy) : null),
          p.timeoutMs === undefined ? null : (p.timeoutMs ?? null),
          p.lastAttemptAt === undefined ? null : (p.lastAttemptAt ?? null),
          p.nextAttemptAt === undefined ? null : (p.nextAttemptAt ?? null),
          p.cancellationRequested === undefined ? null : (p.cancellationRequested ? 1 : 0),
          p.cancellationAcknowledged === undefined ? null : (p.cancellationAcknowledged ? 1 : 0),
          input.jobId, input.expectedStatus,
          useOwner, input.leaseId ?? null, input.workerId ?? null, input.jobId, now,
        );
        changes = r.changes;

        if (r.changes > 0) {
          await this.addEventOnEngine(tx, {
            eventId: `evt_${input.jobId}_${now}_${Math.random().toString(36).slice(2, 10)}`,
            jobId: input.jobId,
            eventType: `execution.transition.${input.newStatus.toLowerCase()}`,
            payload: {
              from: input.expectedStatus, to: input.newStatus, actor: input.actor,
              reason: input.reason ?? null,
              workerId: input.workerId ?? null, leaseId: input.leaseId ?? null,
            },
            createdAt: now,
          } as ExecutionEvent);
        }
      });
    } catch {
      txThrew = true;
    }

    if (txThrew) {
      const cur = await this.getJobAsync(input.jobId);
      return { ok: false, reason: "STATE_MISMATCH", currentStatus: cur?.status ?? null };
    }

    if (changes === 0) {
      const cur = await this.getJobAsync(input.jobId);
      const currentStatus = cur?.status ?? null;
      if (currentStatus === input.newStatus) {
        return { ok: true, applied: false, status: currentStatus, idempotent: true };
      }
      if (input.actor === "worker" && currentStatus === input.expectedStatus) {
        return { ok: false, reason: "WORKER_OWNERSHIP_LOST", currentStatus };
      }
      return { ok: false, reason: "STATE_MISMATCH", currentStatus };
    }

    return { ok: true, applied: true, status: input.newStatus, idempotent: false };
  }

  // ---------- Attempts ----------
  // ============================================================
  // Phase 183c: async attempts + workers persistence.
  //
  // Same SQL and semantics as the sync siblings; routes through this.asyncDb.
  // Fenced variants preserve the EXISTS(ACTIVE lease) guards verbatim.
  // completeAttemptAndTransitionJobAsync is deferred -- it is a multi-write
  // transaction that also writes provenance and needs its own port.
  // ============================================================

  async createAttemptAsync(attempt: ExecutionAttempt): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      INSERT INTO execution_attempts (
        id, job_id, attempt_number, status, worker_id, lease_id,
        started_at, completed_at, error, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.jobId,
      attempt.attemptNumber,
      attempt.status,
      attempt.workerId ?? null,
      attempt.leaseId ?? null,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      attempt.error ?? null,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.createdAt,
    );
  }

  async createAttemptAsOwnerAsync(
    attempt: ExecutionAttempt,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): Promise<{ created: boolean; reason?: "WORKER_OWNERSHIP_LOST" }> {
    const engine = this.requireAsyncDb();
    const owned = await engine.prepareAsync(`
      SELECT 1 FROM execution_leases
      WHERE lease_id = ? AND worker_id = ? AND job_id = ?
        AND status = 'ACTIVE' AND expires_at > ?
    `).get(leaseId, workerId, attempt.jobId, now);
    if (!owned) return { created: false, reason: "WORKER_OWNERSHIP_LOST" };
    try {
      await engine.prepareAsync(`
        INSERT INTO execution_attempts (
          id, job_id, attempt_number, status, worker_id, lease_id,
          started_at, completed_at, error, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.id,
        attempt.jobId,
        attempt.attemptNumber,
        attempt.status,
        attempt.workerId ?? null,
        attempt.leaseId ?? null,
        attempt.startedAt ?? null,
        attempt.completedAt ?? null,
        attempt.error ?? null,
        attempt.evidence ? JSON.stringify(attempt.evidence) : null,
        attempt.createdAt,
      );
      return { created: true };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      const msg = e.message ?? "";
      const isUnique =
        e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        e.code === "23505" ||
        /UNIQUE constraint failed/i.test(msg) ||
        /duplicate key value/i.test(msg);
      if (isUnique) return { created: false };
      throw err;
    }
  }

  async createAttemptAsOwnerAtomicAsync(
    jobId: string,
    leaseId: string,
    workerId: string,
    status: ExecutionAttemptStatus,
    now: number = Date.now(),
  ): Promise<
    | { created: true; attempt: ExecutionAttempt }
    | { created: false; reason: "WORKER_OWNERSHIP_LOST" | "TERMINAL_STATE" | "CANCELLATION_REQUESTED" }
  > {
    const engine = this.requireAsyncDb();
    let result:
      | { created: true; attempt: ExecutionAttempt }
      | { created: false; reason: "WORKER_OWNERSHIP_LOST" | "TERMINAL_STATE" | "CANCELLATION_REQUESTED" }
      = { created: false, reason: "WORKER_OWNERSHIP_LOST" };

    await engine.transactionAsync(async (tx) => {
      const owned = await tx.prepareAsync(`
        SELECT 1 FROM execution_leases
        WHERE lease_id = ? AND worker_id = ? AND job_id = ?
          AND status = 'ACTIVE' AND expires_at > ?
      `).get(leaseId, workerId, jobId, now);
      if (!owned) { result = { created: false, reason: "WORKER_OWNERSHIP_LOST" }; return; }

      const jobRow = await tx.prepareAsync(
        "SELECT status, cancellation_requested FROM execution_jobs WHERE id = ?",
      ).get<{ status: string; cancellation_requested: number }>(jobId);
      if (!jobRow) { result = { created: false, reason: "WORKER_OWNERSHIP_LOST" }; return; }
      if (
        jobRow.status === "SUCCEEDED" ||
        jobRow.status === "FAILED" ||
        jobRow.status === "DEAD_LETTER" ||
        jobRow.status === "CANCELLED"
      ) { result = { created: false, reason: "TERMINAL_STATE" }; return; }
      if (jobRow.cancellation_requested) { result = { created: false, reason: "CANCELLATION_REQUESTED" }; return; }

      const existing = await tx.prepareAsync(
        "SELECT * FROM execution_attempts WHERE job_id = ? AND lease_id = ? AND status = 'RUNNING' LIMIT 1",
      ).get<any>(jobId, leaseId);
      if (existing) { result = { created: true, attempt: this.mapAttempt(existing) }; return; }

      const nextRow = await tx.prepareAsync(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM execution_attempts WHERE job_id = ?",
      ).get<{ next: number }>(jobId);
      const attemptNumber = Number(nextRow?.next ?? 1);

      const attemptId = "attempt_" + jobId + "_" + attemptNumber;
      await tx.prepareAsync(`
        INSERT INTO execution_attempts (
          id, job_id, attempt_number, status, worker_id, lease_id,
          started_at, completed_at, error, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `).run(attemptId, jobId, attemptNumber, status, workerId, leaseId, now, now, now);

      const inserted = await tx.prepareAsync(
        "SELECT * FROM execution_attempts WHERE id = ?",
      ).get<any>(attemptId);
      result = { created: true, attempt: this.mapAttempt(inserted) };
    });

    return result;
  }

  async updateAttemptAsOwnerAsync(
    attempt: ExecutionAttempt,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): Promise<{
    updated: boolean;
    applied?: boolean;
    reason?: "WORKER_OWNERSHIP_LOST" | "ATTEMPT_NOT_FOUND" | "TERMINAL_STATE_CONFLICT";
    attempt?: ExecutionAttempt;
  }> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
        AND job_id = ?
        AND status = 'RUNNING'
        AND EXISTS (
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND job_id = ?
            AND status = 'ACTIVE' AND expires_at > ?
        )
    `).run(
      attempt.status,
      workerId,
      leaseId,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      attempt.error ?? null,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id,
      attempt.jobId,
      leaseId,
      workerId,
      attempt.jobId,
      now,
    );

    if (r.changes === 1) {
      const row = await engine.prepareAsync(
        "SELECT * FROM execution_attempts WHERE id = ?",
      ).get<any>(attempt.id);
      return { updated: true, applied: true, attempt: row ? this.mapAttempt(row) : undefined };
    }

    const diag = await engine.prepareAsync(
      "SELECT * FROM execution_attempts WHERE id = ? AND job_id = ?",
    ).get<any>(attempt.id, attempt.jobId);
    if (!diag) return { updated: false, reason: "ATTEMPT_NOT_FOUND" };
    if (diag.status !== "RUNNING") return { updated: false, reason: "TERMINAL_STATE_CONFLICT" };
    return { updated: false, reason: "WORKER_OWNERSHIP_LOST" };
  }

  async updateAttemptAsync(attempt: ExecutionAttempt): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
    `).run(
      attempt.status,
      attempt.workerId ?? null,
      attempt.leaseId ?? null,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      attempt.error ?? null,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id,
    );
  }

  async getAttemptAsync(id: string): Promise<ExecutionAttempt | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT * FROM execution_attempts WHERE id = ?",
    ).get<any>(id);
    return row ? this.mapAttempt(row) : undefined;
  }

  async listAttemptsForJobAsync(jobId: string): Promise<ExecutionAttempt[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number",
    ).all<any>(jobId);
    return rows.map((r) => this.mapAttempt(r));
  }

  // ---------- Workers (async) ----------

  async registerWorkerAsync(worker: ExecutionWorker): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      INSERT INTO execution_workers (
        worker_id, hostname, capabilities, status, last_heartbeat_at,
        current_job_id, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      worker.workerId,
      worker.hostname ?? null,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt ?? null,
      worker.currentJobId ?? null,
      worker.registeredAt,
    );
  }

  async updateWorkerAsync(worker: ExecutionWorker): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      UPDATE execution_workers SET
        hostname = ?, capabilities = ?, status = ?,
        last_heartbeat_at = ?, current_job_id = ?
      WHERE worker_id = ?
    `).run(
      worker.hostname ?? null,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt ?? null,
      worker.currentJobId ?? null,
      worker.workerId,
    );
  }

  async getWorkerAsync(workerId: string): Promise<ExecutionWorker | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT * FROM execution_workers WHERE worker_id = ?",
    ).get<any>(workerId);
    return row ? this.mapWorker(row) : undefined;
  }

  async listWorkersAsync(): Promise<ExecutionWorker[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_workers",
    ).all<any>();
    return rows.map((r) => this.mapWorker(r));
  }

  async listWorkersByStatusAsync(status: string): Promise<ExecutionWorker[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_workers WHERE status = ?",
    ).all<any>(status);
    return rows.map((r) => this.mapWorker(r));
  }


  // ---------- Leases (async) -- Phase 183 final ----------
  // Parallel to the sync lease methods above. Route through asyncDb only.
  // Never fall back to SQLite. Callers must check hasAsyncBackend() first.

  async acquireLeaseAsync(lease: ExecutionLease): Promise<{ acquired: boolean; existingLease?: ExecutionLease }> {
    const engine = this.requireAsyncDb();
    try {
      await engine.prepareAsync(`
        INSERT INTO execution_leases (
          lease_id, job_id, worker_id, acquired_at, expires_at,
          renewed_at, released_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId, lease.jobId, lease.workerId,
        lease.acquiredAt, lease.expiresAt,
        lease.renewedAt ?? null, lease.releasedAt ?? null, lease.status,
      );
      return { acquired: true };
    } catch (err: any) {
      if (err.code === "23505" || /duplicate key/i.test(String(err.message))) {
        const existing = await this.getActiveNonExpiredLeaseForJobAsync(lease.jobId, lease.acquiredAt);
        return { acquired: false, existingLease: existing };
      }
      throw err;
    }
  }

  async updateLeaseAsync(lease: ExecutionLease): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      UPDATE execution_leases SET
        renewed_at = ?, released_at = ?, status = ?, expires_at = ?
      WHERE lease_id = ?
    `).run(
      lease.renewedAt ?? null, lease.releasedAt ?? null,
      lease.status, lease.expiresAt, lease.leaseId,
    );
  }

  async renewLeaseAsOwnerAsync(
    leaseId: string, workerId: string,
    renewedAt: number, expiresAt: number, now: number,
  ): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE execution_leases SET
        renewed_at = ?,
        expires_at = ?
      WHERE lease_id = ?
        AND worker_id = ?
        AND status = 'ACTIVE'
        AND expires_at > ?
    `).run(renewedAt, expiresAt, leaseId, workerId, now);
    return (r.changes ?? 0) === 1;
  }

  async getLeaseAsync(leaseId: string): Promise<ExecutionLease | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT * FROM execution_leases WHERE lease_id = ?",
    ).get<any>(leaseId);
    return row ? this.mapLease(row) : undefined;
  }

  async getActiveLeaseForJobAsync(jobId: string): Promise<ExecutionLease | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'",
    ).get<any>(jobId);
    return row ? this.mapLease(row) : undefined;
  }

  async getActiveNonExpiredLeaseForJobAsync(jobId: string, now: number = Date.now()): Promise<ExecutionLease | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE' AND expires_at > ?",
    ).get<any>(jobId, now);
    return row ? this.mapLease(row) : undefined;
  }

  async listExpiredLeasesAsync(now: number): Promise<ExecutionLease[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_leases WHERE status = 'ACTIVE' AND expires_at <= ?",
    ).all<any>(now);
    return rows.map((r: any) => this.mapLease(r));
  }


  // ---------- Phase 184: atomic claim (Postgres) ----------
  // Single transaction. SELECT ... FOR UPDATE SKIP LOCKED on the target
  // job row serializes concurrent claimants; the partial unique index
  // idx_leases_one_active_per_job enforces single ACTIVE lease per job.
  // Return shape is identical to sync atomicClaimJob so callers can
  // switch on hasAsyncBackend() without any adaptation.
  async atomicClaimJobAsync(input: {
    jobId: string;
    workerId: string;
    durationMs: number;
    /** Phase 185: which pre-claim status this job must be in. Defaults to
     *  QUEUED for backward compatibility with direct claimants. The scheduler
     *  admits first (QUEUED -> ADMITTED) then claims with fromStatus = "ADMITTED". */
    fromStatus?: "QUEUED" | "ADMITTED";
  }): Promise<{
    claimed: boolean;
    lease?: ExecutionLease;
    reason?: AtomicClaimRejectReason;
  }> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    const lease: ExecutionLease = {
      leaseId: "lease_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 10),
      jobId: input.jobId,
      workerId: input.workerId,
      acquiredAt: now,
      expiresAt: now + input.durationMs,
      status: "ACTIVE",
    };

    let result: {
      claimed: boolean;
      lease?: ExecutionLease;
      reason?: AtomicClaimRejectReason;
    } = { claimed: false };

    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        // 1. Locked guard read.
        const row = await tx.prepareAsync(
          "SELECT status, cancellation_requested, current_lease_id " +
          "FROM execution_jobs WHERE id = ? FOR UPDATE SKIP LOCKED",
        ).get<any>(input.jobId);

        const wantStatus = input.fromStatus ?? "QUEUED";

        if (!row) {
          // Row either does not exist, or another claimant holds the lock.
          // Distinguish via an unlocked read for a useful reason code.
          const unlocked = await tx.prepareAsync(
            "SELECT status, cancellation_requested, current_lease_id " +
            "FROM execution_jobs WHERE id = ?",
          ).get<any>(input.jobId);
          if (!unlocked) { result = { claimed: false, reason: "NOT_QUEUED" }; }
          else if (unlocked.cancellation_requested) { result = { claimed: false, reason: "CANCELLED" }; }
          else if (unlocked.status !== wantStatus) { result = { claimed: false, reason: "NOT_QUEUED" }; }
          else { result = { claimed: false, reason: "ALREADY_LEASED" }; }
          throw new AbortTx();
        }

        if (row.cancellation_requested) { result = { claimed: false, reason: "CANCELLED" }; throw new AbortTx(); }
        if (row.status !== wantStatus) { result = { claimed: false, reason: "NOT_QUEUED" }; throw new AbortTx(); }
        if (row.current_lease_id) { result = { claimed: false, reason: "ALREADY_LEASED" }; throw new AbortTx(); }

        // 2. Expire stale ACTIVE leases for this job only.
        await tx.prepareAsync(
          "UPDATE execution_leases SET status = 'EXPIRED', released_at = ? " +
          "WHERE job_id = ? AND status = 'ACTIVE' AND expires_at <= ?",
        ).run(now, input.jobId, now);

        // 3. INSERT new ACTIVE lease.
        try {
          await tx.prepareAsync(
            "INSERT INTO execution_leases " +
            "(lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
            "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE')",
          ).run(lease.leaseId, lease.jobId, lease.workerId, lease.acquiredAt, lease.expiresAt);
        } catch (err: any) {
          if (err && (err.code === "23505" || /duplicate key/i.test(String(err.message)))) {
            result = { claimed: false, reason: "LEASE_CONFLICT" };
            throw new AbortTx();
          }
          throw err;
        }

        // 4. CAS job UPDATE.
        const jobRes = await tx.prepareAsync(
          "UPDATE execution_jobs SET status = 'CLAIMED', current_lease_id = ?, updated_at = ? " +
          "WHERE id = ? AND status = ?",
        ).run(lease.leaseId, now, input.jobId, wantStatus);

        if ((jobRes.changes ?? 0) !== 1) {
          result = { claimed: false, reason: "ALREADY_LEASED" };
          throw new AbortTx();
        }

        // 5. Durable transition event (matches sync atomicClaimJob semantics).
        const eventId = "evt_claim_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId,
          input.jobId,
          "execution.transition.claimed",
          JSON.stringify({
            jobId: input.jobId,
            workerId: input.workerId,
            leaseId: lease.leaseId,
            from: wantStatus,
            to: "CLAIMED",
          }),
          now,
        );

        result = { claimed: true, lease };
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }

    return result;
  }

  // ---------- Phase 185: distributed scheduler admission ----------
  // Single transaction. pg_advisory_xact_lock serializes admission globally
  // across all NEXUS scheduler processes. Global capacity is re-checked here
  // so no two processes can independently admit past the shared limit.
  //
  // Fairness: effective priority = priority - FLOOR((now - created_at) / aging_ms).
  // Lower value = admitted first. Aging is deterministic and durable -- derived
  // from persisted created_at, not from any in-memory clock.
  //
  // Fenced write: UPDATE ... WHERE id = ? AND status = 'QUEUED' (CAS against
  // concurrent cancellation/claim). Never admits a job that is no longer QUEUED.
  async admitNextJobAsync(input: {
    owner: string;
    capacityLimit: number;
    agingMs?: number;
    now?: number;
  }): Promise<{
    admitted: boolean;
    jobId?: string;
    reason?: "CAPACITY_EXHAUSTED" | "NO_ELIGIBLE_JOBS" | "NO_ELIGIBLE_WORKERS";
    activeCount?: number;
    capacityLimit?: number;
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const agingMs = input.agingMs ?? 60000;
    const ADMISSION_LOCK_KEY = 981411;

    let result: {
      admitted: boolean;
      jobId?: string;
      reason?: "CAPACITY_EXHAUSTED" | "NO_ELIGIBLE_JOBS" | "NO_ELIGIBLE_WORKERS";
      activeCount?: number;
      capacityLimit?: number;
    } = { admitted: false, reason: "NO_ELIGIBLE_JOBS" };

    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        // Global admission lock -- serializes concurrent admit calls across all
        // processes. Held until COMMIT/ROLLBACK.
        await tx.prepareAsync("SELECT pg_advisory_xact_lock(?)").run(ADMISSION_LOCK_KEY);

        // Phase 185: refuse to admit when no worker can execute the job.
        const workerRow = await tx.prepareAsync(
          "SELECT COUNT(*)::int AS cnt FROM execution_workers WHERE status IN ('ONLINE','BUSY')",
        ).get<{ cnt: number }>();
        const eligibleWorkers = workerRow?.cnt ?? 0;
        if (eligibleWorkers === 0) {
          result = {
            admitted: false,
            reason: "NO_ELIGIBLE_WORKERS",
            activeCount: 0,
            capacityLimit: input.capacityLimit,
          };
          throw new AbortTx();
        }

        // Count currently active executions (post-admission, pre-terminal).
        const countRow = await tx.prepareAsync(
          "SELECT COUNT(*)::int AS cnt FROM execution_jobs " +
          "WHERE status IN ('ADMITTED','CLAIMED','RUNNING','VERIFYING','CANCELLATION_REQUESTED')",
        ).get<{ cnt: number }>();
        const activeCount = countRow?.cnt ?? 0;

        if (activeCount >= input.capacityLimit) {
          result = {
            admitted: false,
            reason: "CAPACITY_EXHAUSTED",
            activeCount,
            capacityLimit: input.capacityLimit,
          };
          throw new AbortTx();
        }

        // Pick highest effective priority among eligible QUEUED jobs.
        // Lower effective priority number = admitted first.
        // created_at ASC as a tiebreaker for deterministic FIFO within a priority class.
        const candidate = await tx.prepareAsync(
          "SELECT id, priority, created_at FROM execution_jobs " +
          "WHERE status = 'QUEUED' AND cancellation_requested = 0 " +
          "  AND (next_attempt_at IS NULL OR next_attempt_at <= ?) " +
          "ORDER BY (priority - FLOOR((? - created_at) / ?)) ASC, created_at ASC " +
          "FOR UPDATE SKIP LOCKED LIMIT 1",
        ).get<{ id: string; priority: number; created_at: string | number }>(now, now, agingMs);

        if (!candidate) {
          result = {
            admitted: false,
            reason: "NO_ELIGIBLE_JOBS",
            activeCount,
            capacityLimit: input.capacityLimit,
          };
          throw new AbortTx();
        }

        const epoch = now;
        const upd = await tx.prepareAsync(
          "UPDATE execution_jobs SET status = 'ADMITTED', admitted_at = ?, " +
          "  admission_owner = ?, admission_epoch = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'QUEUED' AND cancellation_requested = 0",
        ).run(now, input.owner, epoch, now, candidate.id);

        if ((upd.changes ?? 0) !== 1) {
          // Lost the CAS race -- another process cancelled or claimed it.
          result = { admitted: false, reason: "NO_ELIGIBLE_JOBS" };
          throw new AbortTx();
        }

        // Durable event -- matches Phase 184 conventions.
        const eventId = "evt_admit_" + candidate.id + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId,
          candidate.id,
          "scheduler.job.admitted",
          JSON.stringify({
            jobId: candidate.id,
            priority: candidate.priority,
            activeCount,
            capacityLimit: input.capacityLimit,
            admissionOwner: input.owner,
            admissionEpoch: epoch,
          }),
          now,
        );

        result = {
          admitted: true,
          jobId: candidate.id,
          activeCount,
          capacityLimit: input.capacityLimit,
        };
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }

    return result;
  }

  // ---------- Phase 185: scheduler-side retry promotion ----------
  // Moves eligible RETRY_SCHEDULED jobs to QUEUED in one atomic UPDATE.
  // Idempotent across schedulers: the status='RETRY_SCHEDULED' filter means
  // a second concurrent call sees the row already promoted and updates 0.
  // Does not touch attempts -- Phase 184's attempt uniqueness fence still holds.
  async promoteDueRetriesAsync(now: number = Date.now()): Promise<number> {
    const engine = this.requireAsyncDb();
    let promoted = 0;

    await engine.transactionAsync(async (tx) => {
      const rows = await tx.prepareAsync(
        "UPDATE execution_jobs SET status = 'QUEUED', next_attempt_at = NULL, updated_at = ? " +
        "WHERE status = 'RETRY_SCHEDULED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? " +
        "RETURNING id",
      ).all<{ id: string }>(now, now);

      for (const r of rows) {
        const eventId = "evt_retry_promote_" + r.id + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId, r.id, "scheduler.retry.promoted",
          JSON.stringify({ jobId: r.id, promotedAt: now }), now,
        );
      }
      promoted = rows.length;
    });

    return promoted;
  }

  // ---------- Phase 185: stale ADMITTED recovery ----------
  // A scheduler that crashes after admit but before claim leaves a job stuck
  // in ADMITTED. This reverts such jobs to QUEUED once their admitted_at is
  // older than ttlMs, so capacity is not permanently leaked. The CAS on
  // status='ADMITTED' is safe under concurrent claim attempts: if the worker
  // claimed first (status = 'CLAIMED'), this UPDATE matches 0 rows.
  async expireStaleAdmissionsAsync(now: number = Date.now(), ttlMs: number = 60000): Promise<number> {
    const engine = this.requireAsyncDb();
    let expired = 0;
    const cutoff = now - ttlMs;

    await engine.transactionAsync(async (tx) => {
      const rows = await tx.prepareAsync(
        "UPDATE execution_jobs SET status = 'QUEUED', admitted_at = NULL, admission_owner = NULL, updated_at = ? " +
        "WHERE status = 'ADMITTED' AND admitted_at IS NOT NULL AND admitted_at < ? " +
        "RETURNING id, admission_owner",
      ).all<{ id: string; admission_owner: string | null }>(now, cutoff);

      for (const r of rows) {
        const eventId = "evt_admission_expired_" + r.id + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId, r.id, "scheduler.admission.expired",
          JSON.stringify({ jobId: r.id, previousOwner: r.admission_owner, expiredAt: now }), now,
        );
      }
      expired = rows.length;
    });

    return expired;
  }

  // ---------- Phase 186: distributed dispatch of admitted jobs ----------
  // Moves an ADMITTED job to CLAIMED by (a) selecting a real eligible worker,
  // (b) creating a durable attempt bound to a fresh lease, and (c) CAS-writing
  // job.status. All in one transaction.
  //
  // Fencing model (unchanged from Phase 183/184):
  //   - execution_leases.lease_id is the fencing token; the Phase 184 partial
  //     unique index idx_leases_one_active_per_job prevents two ACTIVE leases
  //     for the same job.
  //   - execution_attempts.lease_id binds the attempt to that lease.
  //   - A stale worker's attempt update is rejected by the ownership WHERE
  //     clause in updateAttemptAsOwnerAsync / completeAttemptAndTransitionJobAsync.
  //
  // Worker capacity is derived, not stored: the number of ACTIVE leases held
  // by a worker is its current execution count. maxConcurrencyPerWorker
  // defaults to 1. This is distinct from Phase 185's global admission capacity.
  async dispatchAdmittedJobAsync(input: {
    jobId: string;
    workerId?: string;
    maxConcurrencyPerWorker?: number;
    leaseDurationMs?: number;
    now?: number;
  }): Promise<{
    dispatched: boolean;
    attemptId?: string;
    leaseId?: string;
    workerId?: string;
    reason?: "NOT_ADMITTED" | "CANCELLED" | "WORKER_NOT_FOUND" | "WORKER_NOT_ELIGIBLE" | "WORKER_AT_CAPACITY" | "DISPATCH_CONFLICT";
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const leaseDurationMs = input.leaseDurationMs ?? 60000;
    const cap = input.maxConcurrencyPerWorker ?? 1;

    let result: {
      dispatched: boolean;
      attemptId?: string;
      leaseId?: string;
      workerId?: string;
      reason?: "NOT_ADMITTED" | "CANCELLED" | "WORKER_NOT_FOUND" | "WORKER_NOT_ELIGIBLE" | "WORKER_AT_CAPACITY" | "DISPATCH_CONFLICT";
    } = { dispatched: false };

    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        // 1. Lock the job row. FOR UPDATE (not SKIP LOCKED): a concurrent
        //    dispatch of the same job should block, then see NOT_ADMITTED,
        //    rather than silently skipping and reporting NOT_ADMITTED for a
        //    job it never observed.
        const jobRow = await tx.prepareAsync(
          "SELECT id, status, cancellation_requested, current_lease_id " +
          "FROM execution_jobs WHERE id = ? FOR UPDATE",
        ).get<{ id: string; status: string; cancellation_requested: number; current_lease_id: string | null }>(input.jobId);

        if (!jobRow) { result = { dispatched: false, reason: "NOT_ADMITTED" }; throw new AbortTx(); }
        if (jobRow.cancellation_requested) { result = { dispatched: false, reason: "CANCELLED" }; throw new AbortTx(); }
        if (jobRow.status !== "ADMITTED") { result = { dispatched: false, reason: "NOT_ADMITTED" }; throw new AbortTx(); }
        if (jobRow.current_lease_id) { result = { dispatched: false, reason: "DISPATCH_CONFLICT" }; throw new AbortTx(); }

        // 2. Resolve worker.
        let workerId = input.workerId;
        if (workerId) {
          const w = await tx.prepareAsync(
            "SELECT worker_id, status FROM execution_workers WHERE worker_id = ? FOR UPDATE",
          ).get<{ worker_id: string; status: string }>(workerId);
          if (!w) { result = { dispatched: false, reason: "WORKER_NOT_FOUND" }; throw new AbortTx(); }
          if (w.status !== "ONLINE" && w.status !== "BUSY") {
            result = { dispatched: false, reason: "WORKER_NOT_ELIGIBLE" };
            throw new AbortTx();
          }
        } else {
          // Dispatcher-chosen worker: lowest active-lease count, deterministic
          // tiebreak by worker_id. FOR UPDATE OF w SKIP LOCKED serializes
          // concurrent dispatchers against the same candidate worker.
          const w = await tx.prepareAsync(
            "SELECT w.worker_id, " +
            "  (SELECT COUNT(*)::int FROM execution_leases l " +
            "   WHERE l.worker_id = w.worker_id AND l.status = 'ACTIVE') AS active_cnt " +
            "FROM execution_workers w " +
            "WHERE w.status IN ('ONLINE','BUSY') " +
            "ORDER BY active_cnt ASC, w.worker_id ASC " +
            "FOR UPDATE OF w SKIP LOCKED LIMIT 1",
          ).get<{ worker_id: string; active_cnt: number }>();
          if (!w) { result = { dispatched: false, reason: "WORKER_NOT_FOUND" }; throw new AbortTx(); }
          workerId = w.worker_id;
        }

        // 3. Capacity check (covers the pinned-worker case; the auto-selected
        //    case already filtered by active_cnt but we re-verify inside the
        //    locked worker view).
        const activeRow = await tx.prepareAsync(
          "SELECT COUNT(*)::int AS cnt FROM execution_leases " +
          "WHERE worker_id = ? AND status = 'ACTIVE'",
        ).get<{ cnt: number }>(workerId);
        const activeCount = activeRow?.cnt ?? 0;
        if (activeCount >= cap) {
          result = { dispatched: false, reason: "WORKER_AT_CAPACITY" };
          throw new AbortTx();
        }

        // 4. Compute attempt number before inserting (used in both ids).
        const nextRow = await tx.prepareAsync(
          "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM execution_attempts WHERE job_id = ?",
        ).get<{ next: number }>(input.jobId);
        const attemptNumber = Number(nextRow?.next ?? 1);

        const attemptId = "attempt_" + input.jobId + "_" + attemptNumber;
        const leaseId = "lease_dispatch_" + input.jobId + "_" + attemptNumber + "_" + now + "_" + Math.random().toString(36).slice(2, 8);

        // 5. INSERT lease. The partial unique index enforces single ACTIVE per job.
        try {
          await tx.prepareAsync(
            "INSERT INTO execution_leases " +
            "(lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
            "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE')",
          ).run(leaseId, input.jobId, workerId, now, now + leaseDurationMs);
        } catch (err: any) {
          if (err && (err.code === "23505" || /duplicate key/i.test(String(err.message)))) {
            result = { dispatched: false, reason: "DISPATCH_CONFLICT" };
            throw new AbortTx();
          }
          throw err;
        }

        // 6. INSERT attempt bound to the same lease. Status RUNNING because
        //    the worker is expected to start execution immediately upon
        //    receiving ownership.
        await tx.prepareAsync(
          "INSERT INTO execution_attempts " +
          "(id, job_id, attempt_number, status, worker_id, lease_id, started_at, completed_at, error, evidence, created_at, heartbeat_at) " +
          "VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, NULL, NULL, NULL, ?, ?)",
        ).run(attemptId, input.jobId, attemptNumber, workerId, leaseId, now, now, now);

        // 7. CAS the job: ADMITTED -> CLAIMED. Explicit status + cancel guard.
        const upd = await tx.prepareAsync(
          "UPDATE execution_jobs SET status = 'CLAIMED', current_lease_id = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'ADMITTED' AND cancellation_requested = 0",
        ).run(leaseId, now, input.jobId);

        if ((upd.changes ?? 0) !== 1) {
          result = { dispatched: false, reason: "DISPATCH_CONFLICT" };
          throw new AbortTx();
        }

        // 8. Durable event.
        const eventId = "evt_dispatch_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId,
          input.jobId,
          "scheduler.job.dispatched",
          JSON.stringify({
            jobId: input.jobId,
            attemptId,
            leaseId,
            workerId,
            attemptNumber,
            dispatchedAt: now,
          }),
          now,
        );

        result = {
          dispatched: true,
          attemptId,
          leaseId,
          workerId,
        };
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }

    return result;
  }
  async clearJobLeaseByLeaseIdAsync(leaseId: string): Promise<void> {
    const engine = this.requireAsyncDb();
    await engine.prepareAsync(`
      UPDATE execution_jobs SET current_lease_id = NULL
      WHERE current_lease_id = ?
    `).run(leaseId);
  }
  createAttempt(attempt: ExecutionAttempt): void {
    this.db.prepare(`
      INSERT INTO execution_attempts (
        id, job_id, attempt_number, status, worker_id, lease_id,
        started_at, completed_at, error, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.jobId,
      attempt.attemptNumber,
      attempt.status,
      attempt.workerId,
      attempt.leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.createdAt
    );
  }

  /**
   * Phase 136: worker-authoritative attempt creation. Fenced by the same
   * lease invariant used by transitionExecution and updateJobAsOwner:
   * the INSERT is rejected unless the caller holds an ACTIVE, unexpired
   * lease for (lease_id, worker_id, job_id). A stale worker receives
   * WORKER_OWNERSHIP_LOST and no attempt row is written.
   */
  createAttemptAsOwner(
    attempt: ExecutionAttempt,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): { created: boolean; reason?: "WORKER_OWNERSHIP_LOST" } {
    const owned = this.db.prepare(`
      SELECT 1 FROM execution_leases
      WHERE lease_id = ? AND worker_id = ? AND job_id = ?
        AND status = 'ACTIVE' AND expires_at > ?
    `).get(leaseId, workerId, attempt.jobId, now);
    if (!owned) {
      return { created: false, reason: "WORKER_OWNERSHIP_LOST" };
    }
    try {
      this.db.prepare(`
        INSERT INTO execution_attempts (
          id, job_id, attempt_number, status, worker_id, lease_id,
          started_at, completed_at, error, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.id,
        attempt.jobId,
        attempt.attemptNumber,
        attempt.status,
        attempt.workerId,
        attempt.leaseId,
        attempt.startedAt,
        attempt.completedAt,
        attempt.error,
        attempt.evidence ? JSON.stringify(attempt.evidence) : null,
        attempt.createdAt,
      );
      return { created: true };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (
        e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        /UNIQUE constraint failed/i.test(e.message ?? "")
      ) {
        return { created: false };
      }
      throw err;
    }
  }

  /**
   * Phase 148: atomic durable attempt allocation.
   *
   * Replaces the read-then-write pattern listAttemptsForJob(jobId).length + 1
   * with an in-transaction allocation. Within the transaction:
   *   1. lease ownership is verified (ACTIVE, unexpired, matching job/worker)
   *   2. job state is verified (not terminal, not cancellation-requested)
   *   3. idempotency check: an existing RUNNING attempt for (jobId, leaseId)
   *      is returned as-is rather than creating a duplicate
   *   4. MAX(attempt_number) + 1 is computed inside the same transaction
   *   5. the attempt row is inserted inside the same transaction
   *
   * better-sqlite3 serializes writers at the transaction boundary, so two
   * callers cannot both observe the same MAX and both insert. Migration 155's
   * UNIQUE(job_id, attempt_number) remains the durable backstop.
   */
  createAttemptAsOwnerAtomic(
    jobId: string,
    leaseId: string,
    workerId: string,
    status: ExecutionAttemptStatus,
    now: number = Date.now(),
  ):
    | { created: true; attempt: ExecutionAttempt }
    | { created: false; reason: "WORKER_OWNERSHIP_LOST" | "TERMINAL_STATE" | "CANCELLATION_REQUESTED" } {

    let result:
      | { created: true; attempt: ExecutionAttempt }
      | { created: false; reason: "WORKER_OWNERSHIP_LOST" | "TERMINAL_STATE" | "CANCELLATION_REQUESTED" }
      = { created: false, reason: "WORKER_OWNERSHIP_LOST" };

    const run = (): void => {
      const owned = this.db.prepare(`
        SELECT 1 FROM execution_leases
        WHERE lease_id = ? AND worker_id = ? AND job_id = ?
          AND status = 'ACTIVE' AND expires_at > ?
      `).get(leaseId, workerId, jobId, now);
      if (!owned) { result = { created: false, reason: "WORKER_OWNERSHIP_LOST" }; return; }

      const jobRow = this.db.prepare(
        "SELECT status, cancellation_requested FROM execution_jobs WHERE id = ?"
      ).get(jobId) as { status: string; cancellation_requested: number } | undefined;
      if (!jobRow) { result = { created: false, reason: "WORKER_OWNERSHIP_LOST" }; return; }
      if (
        jobRow.status === "SUCCEEDED" ||
        jobRow.status === "FAILED" ||
        jobRow.status === "DEAD_LETTER" ||
        jobRow.status === "CANCELLED"
      ) { result = { created: false, reason: "TERMINAL_STATE" }; return; }
      if (jobRow.cancellation_requested) { result = { created: false, reason: "CANCELLATION_REQUESTED" }; return; }

      const existing = this.db.prepare(
        "SELECT * FROM execution_attempts WHERE job_id = ? AND lease_id = ? AND status = 'RUNNING' LIMIT 1"
      ).get(jobId, leaseId) as any;
      if (existing) { result = { created: true, attempt: this.mapAttempt(existing) }; return; }

      const nextRow = this.db.prepare(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM execution_attempts WHERE job_id = ?"
      ).get(jobId) as { next: number };
      const attemptNumber = nextRow.next;

      const attemptId = "attempt_" + jobId + "_" + attemptNumber;
      this.db.prepare(`
        INSERT INTO execution_attempts (
          id, job_id, attempt_number, status, worker_id, lease_id,
          started_at, completed_at, error, evidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `).run(attemptId, jobId, attemptNumber, status, workerId, leaseId, now, now);

      const inserted = this.db.prepare(
        "SELECT * FROM execution_attempts WHERE id = ?"
      ).get(attemptId) as any;
      result = { created: true, attempt: this.mapAttempt(inserted) };
    };

    const maybeTx: any = (this.db as any).transaction(run);
    if (typeof maybeTx === "function") maybeTx();
    return result;
  }

  /**
   * Phase 136: worker-authoritative attempt update. WHERE clause carries the
   * same EXISTS(ACTIVE, unexpired, matching lease_id+worker_id+job_id) as
   * updateJobAsOwner and transitionExecution. A stale worker's UPDATE matches
   * zero rows and no attempt evidence is committed.
   */
  /**
   * Phase 136 / Phase 149: worker-authoritative attempt update.
   *
   * WHERE clause fences on:
   *   - the attempt id
   *   - the attempt's job_id (prevents cross-job mutation when a caller
   *     misprograms the id)
   *   - the current attempt status being RUNNING (Phase 149: terminal
   *     attempts cannot be re-terminalized or resurrected)
   *   - an ACTIVE, unexpired lease matching lease_id + worker_id + job_id
   *     (Phase 136: stale workers commit no evidence)
   *
   * Return shape (Phase 149):
   *   { updated: true,  applied: true,  attempt }  mutation committed
   *   { updated: true,  applied: false, attempt }  idempotent replay (already terminal-as-targeted)
   *   { updated: false, reason: "ATTEMPT_NOT_FOUND" }        unknown id / job mismatch
   *   { updated: false, reason: "WORKER_OWNERSHIP_LOST" }     lease fence blocked
   *   { updated: false, reason: "TERMINAL_STATE_CONFLICT" }   terminal mismatch
   *
   * The UPDATE is the authoritative concurrency mechanism. The diagnostic
   * SELECT that follows runs only when the UPDATE commits zero rows, and it
   * only classifies the outcome; it does not mutate.
   */
  updateAttemptAsOwner(
    attempt: ExecutionAttempt,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): {
    updated: boolean;
    applied?: boolean;
    reason?: "WORKER_OWNERSHIP_LOST" | "ATTEMPT_NOT_FOUND" | "TERMINAL_STATE_CONFLICT";
    attempt?: ExecutionAttempt;
  } {
    const result = this.db.prepare(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
        AND job_id = ?
        AND status = 'RUNNING'
        AND EXISTS (
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND job_id = ?
            AND status = 'ACTIVE' AND expires_at > ?
        )
    `).run(
      attempt.status,
      workerId,
      leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id,
      attempt.jobId,
      leaseId,
      workerId,
      attempt.jobId,
      now,
    );

    if ((result.changes ?? 0) === 1) {
      const row = this.db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(attempt.id) as any;
      return { updated: true, applied: true, attempt: row ? this.mapAttempt(row) : undefined };
    }

    // Diagnostic classification only Ã¢â‚¬â€ the authoritative mutation is the UPDATE above.
    const row = this.db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(attempt.id) as any;
    if (!row || row.job_id !== attempt.jobId) {
      return { updated: false, reason: "ATTEMPT_NOT_FOUND" };
    }

    const targetTerminal =
      attempt.status === "SUCCEEDED" ||
      attempt.status === "FAILED" ||
      attempt.status === "CANCELLED" ||
      attempt.status === "DEAD_LETTER";
    const currentTerminal =
      row.status === "SUCCEEDED" ||
      row.status === "FAILED" ||
      row.status === "CANCELLED" ||
      row.status === "DEAD_LETTER";

    if (targetTerminal && row.status === attempt.status) {
      return { updated: true, applied: false, attempt: this.mapAttempt(row) };
    }
    if (currentTerminal) {
      return { updated: false, reason: "TERMINAL_STATE_CONFLICT", attempt: this.mapAttempt(row) };
    }
    return { updated: false, reason: "WORKER_OWNERSHIP_LOST" };
  }


  updateAttempt(attempt: ExecutionAttempt): void {
    this.db.prepare(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
    `).run(
      attempt.status,
      attempt.workerId,
      attempt.leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id
    );
  }

  getAttempt(id: string): ExecutionAttempt | undefined {
    const row = this.db.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id);
    return row ? this.mapAttempt(row) : undefined;
  }

  /**
   * Phase 150: atomic attempt terminalization + parent job transition.
   *
   * The live executeJob path used to perform two durable writes:
   *   (1) transitionExecution(parent)
   *   (2) updateAttemptAsOwner(attempt)
   * A crash between them left job=terminal, attempt=RUNNING, with no recovery
   * path that would close the attempt (recoverStaleJobs skips terminal jobs).
   *
   * This method performs both mutations and the durable transition event in
   * one SQLite transaction. If any of the following fails, nothing commits:
   *   - worker lease fence (ACTIVE, unexpired, matching job/worker/lease)
   *   - attempt id + job_id + status='RUNNING' fence
   *   - job expected-state CAS
   *
   * State-machine legality and actor authorization remain the caller's
   * responsibility (ExecutionEngine.applyTransitionWithAttempt).
   */
  completeAttemptAndTransitionJob(input: {
    attemptId: string;
    jobId: string;
    leaseId: string;
    workerId: string;
    attemptStatus: "SUCCEEDED" | "FAILED" | "CANCELLED";
    attemptError?: string;
    attemptEvidence?: string[];
    attemptCompletedAt?: number;
    expectedJobStatus: string;
    newJobStatus: string;
    patch?: {
      currentLeaseId?: string | null;
      retryPolicy?: unknown;
      timeoutMs?: number | null;
      lastAttemptAt?: number | null;
      nextAttemptAt?: number | null;
      cancellationRequested?: boolean;
      cancellationAcknowledged?: boolean;
    };
    reason?: string;
    now?: number;
    recoveryOperationId?: string | null;
  }): {
    ok: boolean;
    applied?: boolean;
    idempotent?: boolean;
    reason?: "WORKER_OWNERSHIP_LOST" | "STATE_MISMATCH" | "TERMINAL_STATE"
           | "JOB_NOT_FOUND" | "ATTEMPT_NOT_FOUND" | "ATTEMPT_STATE_MISMATCH";
    attempt?: ExecutionAttempt;
    jobStatus?: string;
  } {
    const now = input.now ?? Date.now();

    class AbortTx extends Error {}
    let result: {
      ok: boolean;
      applied?: boolean;
      idempotent?: boolean;
      reason?: any;
      attempt?: ExecutionAttempt;
      jobStatus?: string;
    } = { ok: false, reason: "STATE_MISMATCH" };

    const run = (): void => {
      // 0. Pre-read for diagnostics and terminal conflict detection.
      const attemptBefore = this.db.prepare(
        "SELECT * FROM execution_attempts WHERE id = ?"
      ).get(input.attemptId) as any;
      const jobBefore = this.db.prepare(
        "SELECT * FROM execution_jobs WHERE id = ?"
      ).get(input.jobId) as any;

      if (!jobBefore) { result = { ok: false, reason: "JOB_NOT_FOUND" }; throw new AbortTx(); }
      if (!attemptBefore || attemptBefore.job_id !== input.jobId) {
        result = { ok: false, reason: "ATTEMPT_NOT_FOUND" }; throw new AbortTx();
      }

      // Worker lease fence (mirror of transitionExecution).
      const owned = this.db.prepare(`
        SELECT 1 FROM execution_leases
        WHERE lease_id = ? AND worker_id = ? AND job_id = ?
          AND status = 'ACTIVE' AND expires_at > ?
      `).get(input.leaseId, input.workerId, input.jobId, now);
      if (!owned) { result = { ok: false, reason: "WORKER_OWNERSHIP_LOST" }; throw new AbortTx(); }

      // Idempotent replay: job already in target and attempt already terminal as targeted.
      const attemptTerminal = attemptBefore.status === input.attemptStatus;
      const jobAtTarget = jobBefore.status === input.newJobStatus;
      if (attemptTerminal && jobAtTarget) {
        result = {
          ok: true, applied: false, idempotent: true,
          attempt: this.mapAttempt(attemptBefore),
          jobStatus: jobBefore.status,
        };
        throw new AbortTx();
      }

      // Terminal conflict: attempt already terminal but not as targeted.
      const attemptIsTerminal =
        attemptBefore.status === "SUCCEEDED" || attemptBefore.status === "FAILED" ||
        attemptBefore.status === "CANCELLED" || attemptBefore.status === "DEAD_LETTER";
      if (attemptIsTerminal && !attemptTerminal) {
        result = { ok: false, reason: "ATTEMPT_STATE_MISMATCH", attempt: this.mapAttempt(attemptBefore) };
        throw new AbortTx();
      }

      // 1. Attempt UPDATE (Phase 149 fence).
      const aRes = this.db.prepare(`
        UPDATE execution_attempts SET
          status = ?, worker_id = ?, lease_id = ?, started_at = ?,
          completed_at = ?, error = ?, evidence = ?
        WHERE id = ?
          AND job_id = ?
          AND status = 'RUNNING'
          AND EXISTS (
            SELECT 1 FROM execution_leases
            WHERE lease_id = ? AND worker_id = ? AND job_id = ?
              AND status = 'ACTIVE' AND expires_at > ?
          )
      `).run(
        input.attemptStatus,
        input.workerId,
        input.leaseId,
        attemptBefore.started_at,
        input.attemptCompletedAt ?? now,
        input.attemptError ?? null,
        input.attemptEvidence ? JSON.stringify(input.attemptEvidence) : null,
        input.attemptId,
        input.jobId,
        input.leaseId,
        input.workerId,
        input.jobId,
        now,
      );
      if ((aRes.changes ?? 0) !== 1) {
        result = { ok: false, reason: "ATTEMPT_STATE_MISMATCH", attempt: this.mapAttempt(attemptBefore) };
        throw new AbortTx();
      }

      // 2. Job UPDATE (mirror of transitionExecution).
      const p = input.patch ?? {};
      const jRes = this.db.prepare(`
        UPDATE execution_jobs SET
          status = ?, updated_at = ?,
          current_lease_id          = COALESCE(?, current_lease_id),
          retry_policy              = COALESCE(?, retry_policy),
          timeout_ms                = COALESCE(?, timeout_ms),
          last_attempt_at           = COALESCE(?, last_attempt_at),
          next_attempt_at           = COALESCE(?, next_attempt_at),
          cancellation_requested    = COALESCE(?, cancellation_requested),
          cancellation_acknowledged = COALESCE(?, cancellation_acknowledged)
        WHERE id = ? AND status = ?
      `).run(
        input.newJobStatus,
        now,
        p.currentLeaseId === undefined ? null : (p.currentLeaseId ?? null),
        p.retryPolicy === undefined ? null : (p.retryPolicy ? JSON.stringify(p.retryPolicy) : null),
        p.timeoutMs === undefined ? null : (p.timeoutMs ?? null),
        p.lastAttemptAt === undefined ? null : (p.lastAttemptAt ?? null),
        p.nextAttemptAt === undefined ? null : (p.nextAttemptAt ?? null),
        p.cancellationRequested === undefined ? null : (p.cancellationRequested ? 1 : 0),
        p.cancellationAcknowledged === undefined ? null : (p.cancellationAcknowledged ? 1 : 0),
        input.jobId,
        input.expectedJobStatus,
      );
      if ((jRes.changes ?? 0) !== 1) {
        result = { ok: false, reason: "STATE_MISMATCH" };
        throw new AbortTx();
      }

      // 3. Durable transition event (mirror of transitionExecution).
      this.addEvent({
        eventId: `evt_${input.jobId}_${now}_${Math.random().toString(36).slice(2, 10)}`,
        jobId: input.jobId,
        eventType: `execution.transition.${input.newJobStatus.toLowerCase()}`,
        payload: {
          from: input.expectedJobStatus,
          to: input.newJobStatus,
          actor: "worker",
          reason: input.reason ?? null,
          workerId: input.workerId,
          leaseId: input.leaseId,
        },
        createdAt: now,
      });

      // 4. Phase 165: durable terminal provenance.
      const evidenceJson = input.attemptEvidence ? JSON.stringify(input.attemptEvidence) : null;
      const terminalizedAt = input.attemptCompletedAt ?? now;
      const evidenceHash = sha256(JSON.stringify({
      outcome: input.attemptStatus,
      previous_state: attemptBefore.status,
      attempt_id: input.attemptId,
      evidence_json: evidenceJson,
      terminalized_at: terminalizedAt,
    }));
      const predecessorRow = this.db.prepare(
        "SELECT id FROM execution_attempts WHERE job_id = ? AND attempt_number = ?"
      ).get(input.jobId, attemptBefore.attempt_number - 1) as { id: string } | undefined;
      const provenanceId = "prov_" + input.attemptId + "_" + now;
      this.db.prepare(
        "INSERT INTO execution_outcome_provenance " +
        "  (provenance_id, job_id, attempt_id, attempt_number, outcome, " +
        "   previous_state, worker_id, lease_id, recovery_operation_id, " +
        "   predecessor_attempt_id, reason, evidence_json, evidence_hash, " +
        "   terminalized_at, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(
        provenanceId,
        input.jobId,
        input.attemptId,
        attemptBefore.attempt_number,
        input.attemptStatus,
        attemptBefore.status,
        input.workerId,
        input.leaseId,
        input.recoveryOperationId ?? null,
        predecessorRow?.id ?? null,
        input.attemptError ?? input.reason ?? null,
        evidenceJson,
        evidenceHash,
        terminalizedAt,
        now,
      );

      const attemptAfter = this.db.prepare(
        "SELECT * FROM execution_attempts WHERE id = ?"
      ).get(input.attemptId) as any;
      result = {
        ok: true, applied: true, idempotent: false,
        attempt: this.mapAttempt(attemptAfter),
        jobStatus: input.newJobStatus,
      };
    };

    try {
      const maybeTx: any = (this.db as any).transaction(run);
      if (typeof maybeTx === "function") maybeTx();
    } catch (err) {
      if (!(err instanceof AbortTx)) throw err;
      // result already set; transaction rolled back by the shim
    }
    return result;
  }

  async completeAttemptAndTransitionJobAsync(input: {
    attemptId: string;
    jobId: string;
    leaseId: string;
    workerId: string;
    attemptStatus: "SUCCEEDED" | "FAILED" | "CANCELLED";
    attemptError?: string;
    attemptEvidence?: string[];
    attemptCompletedAt?: number;
    expectedJobStatus: string;
    newJobStatus: string;
    patch?: {
      currentLeaseId?: string | null;
      retryPolicy?: unknown;
      timeoutMs?: number | null;
      lastAttemptAt?: number | null;
      nextAttemptAt?: number | null;
      cancellationRequested?: boolean;
      cancellationAcknowledged?: boolean;
    };
    reason?: string;
    now?: number;
    recoveryOperationId?: string | null;
    /** Phase 188: artifacts to commit atomically with completion. */
    artifacts?: ArtifactRecord[];
  }): Promise<{
    ok: boolean;
    applied?: boolean;
    idempotent?: boolean;
    reason?: "WORKER_OWNERSHIP_LOST" | "STATE_MISMATCH" | "TERMINAL_STATE"
           | "JOB_NOT_FOUND" | "ATTEMPT_NOT_FOUND" | "ATTEMPT_STATE_MISMATCH";
    attempt?: ExecutionAttempt;
    jobStatus?: string;
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();

    class AbortTx extends Error {}
    let result: {
      ok: boolean;
      applied?: boolean;
      idempotent?: boolean;
      reason?: any;
      attempt?: ExecutionAttempt;
      jobStatus?: string;
    } = { ok: false, reason: "STATE_MISMATCH" };

    try {
      await engine.transactionAsync(async (tx) => {
        // Phase 188: FOR UPDATE serializes concurrent completions on the
        // same attempt. The loser of the race blocks here, then re-reads the
        // terminal row (READ COMMITTED) and returns idempotent rather than
        // racing the UPDATE. Without this lock, the loser sees RUNNING and
        // returns ATTEMPT_STATE_MISMATCH on concurrent duplicate completion.
        const attemptBefore = await tx.prepareAsync(
          "SELECT * FROM execution_attempts WHERE id = ? FOR UPDATE",
        ).get<any>(input.attemptId);
        const jobBefore = await tx.prepareAsync(
          "SELECT * FROM execution_jobs WHERE id = ?",
        ).get<any>(input.jobId);

        if (!jobBefore) { result = { ok: false, reason: "JOB_NOT_FOUND" }; throw new AbortTx(); }
        if (!attemptBefore || attemptBefore.job_id !== input.jobId) {
          result = { ok: false, reason: "ATTEMPT_NOT_FOUND" }; throw new AbortTx();
        }

        // Phase 188: check idempotent return FIRST. A duplicate completion
        // from the original owner must get a clean idempotent confirmation
        // even though the lease is no longer ACTIVE (it was released when the
        // terminal transition committed). We still verify caller identity to
        // prevent a stale/different worker from faking idempotency.
        const attemptTerminal = attemptBefore.status === input.attemptStatus;
        const jobAtTarget = jobBefore.status === input.newJobStatus;
        if (attemptTerminal && jobAtTarget) {
          if (attemptBefore.worker_id !== input.workerId || attemptBefore.lease_id !== input.leaseId) {
            result = { ok: false, reason: "WORKER_OWNERSHIP_LOST" };
            throw new AbortTx();
          }
          result = {
            ok: true, applied: false, idempotent: true,
            attempt: this.mapAttempt(attemptBefore),
            jobStatus: jobBefore.status,
          };
          throw new AbortTx();
        }

        const owned = await tx.prepareAsync(`
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND job_id = ?
            AND status = 'ACTIVE' AND expires_at > ?
        `).get(input.leaseId, input.workerId, input.jobId, now);
        if (!owned) { result = { ok: false, reason: "WORKER_OWNERSHIP_LOST" }; throw new AbortTx(); }

        const attemptIsTerminal =
          attemptBefore.status === "SUCCEEDED" || attemptBefore.status === "FAILED" ||
          attemptBefore.status === "CANCELLED" || attemptBefore.status === "DEAD_LETTER";
        if (attemptIsTerminal && !attemptTerminal) {
          result = { ok: false, reason: "ATTEMPT_STATE_MISMATCH", attempt: this.mapAttempt(attemptBefore) };
          throw new AbortTx();
        }

        const aRes = await tx.prepareAsync(`
          UPDATE execution_attempts SET
            status = ?, worker_id = ?, lease_id = ?, started_at = ?,
            completed_at = ?, error = ?, evidence = ?
          WHERE id = ?
            AND job_id = ?
            AND status = 'RUNNING'
            AND EXISTS (
              SELECT 1 FROM execution_leases
              WHERE lease_id = ? AND worker_id = ? AND job_id = ?
                AND status = 'ACTIVE' AND expires_at > ?
            )
        `).run(
          input.attemptStatus,
          input.workerId,
          input.leaseId,
          attemptBefore.started_at,
          input.attemptCompletedAt ?? now,
          input.attemptError ?? null,
          input.attemptEvidence ? JSON.stringify(input.attemptEvidence) : null,
          input.attemptId,
          input.jobId,
          input.leaseId,
          input.workerId,
          input.jobId,
          now,
        );
        if ((aRes.changes ?? 0) !== 1) {
          result = { ok: false, reason: "ATTEMPT_STATE_MISMATCH", attempt: this.mapAttempt(attemptBefore) };
          throw new AbortTx();
        }

        const p = input.patch ?? {};
        const jRes = await tx.prepareAsync(`
          UPDATE execution_jobs SET
            status = ?, updated_at = ?,
            current_lease_id          = COALESCE(?, current_lease_id),
            retry_policy              = COALESCE(?, retry_policy),
            timeout_ms                = COALESCE(?, timeout_ms),
            last_attempt_at           = COALESCE(?, last_attempt_at),
            next_attempt_at           = COALESCE(?, next_attempt_at),
            cancellation_requested    = COALESCE(?, cancellation_requested),
            cancellation_acknowledged = COALESCE(?, cancellation_acknowledged)
          WHERE id = ? AND status = ?
        `).run(
          input.newJobStatus,
          now,
          p.currentLeaseId === undefined ? null : (p.currentLeaseId ?? null),
          p.retryPolicy === undefined ? null : (p.retryPolicy ? JSON.stringify(p.retryPolicy) : null),
          p.timeoutMs === undefined ? null : (p.timeoutMs ?? null),
          p.lastAttemptAt === undefined ? null : (p.lastAttemptAt ?? null),
          p.nextAttemptAt === undefined ? null : (p.nextAttemptAt ?? null),
          p.cancellationRequested === undefined ? null : (p.cancellationRequested ? 1 : 0),
          p.cancellationAcknowledged === undefined ? null : (p.cancellationAcknowledged ? 1 : 0),
          input.jobId,
          input.expectedJobStatus,
        );
        if ((jRes.changes ?? 0) !== 1) {
          result = { ok: false, reason: "STATE_MISMATCH" };
          throw new AbortTx();
        }

        await this.addEventOnEngine(tx, {
          eventId: `evt_${input.jobId}_${now}_${Math.random().toString(36).slice(2, 10)}`,
          jobId: input.jobId,
          eventType: `execution.transition.${input.newJobStatus.toLowerCase()}`,
          payload: {
            from: input.expectedJobStatus,
            to: input.newJobStatus,
            actor: "worker",
            reason: input.reason ?? null,
            workerId: input.workerId,
            leaseId: input.leaseId,
          },
          createdAt: now,
        } as ExecutionEvent);

        const evidenceJson = input.attemptEvidence ? JSON.stringify(input.attemptEvidence) : null;
        const terminalizedAt = input.attemptCompletedAt ?? now;
        const evidenceHash = sha256(JSON.stringify({
          outcome: input.attemptStatus,
          previous_state: attemptBefore.status,
          attempt_id: input.attemptId,
          evidence_json: evidenceJson,
          terminalized_at: terminalizedAt,
        }));
        const predecessorRow = await tx.prepareAsync(
          "SELECT id FROM execution_attempts WHERE job_id = ? AND attempt_number = ?",
        ).get<{ id: string }>(input.jobId, attemptBefore.attempt_number - 1);
        const provenanceId = "prov_" + input.attemptId + "_" + now;
        await tx.prepareAsync(
          "INSERT INTO execution_outcome_provenance " +
          "  (provenance_id, job_id, attempt_id, attempt_number, outcome, " +
          "   previous_state, worker_id, lease_id, recovery_operation_id, " +
          "   predecessor_attempt_id, reason, evidence_json, evidence_hash, " +
          "   terminalized_at, created_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          provenanceId,
          input.jobId,
          input.attemptId,
          attemptBefore.attempt_number,
          input.attemptStatus,
          attemptBefore.status,
          input.workerId,
          input.leaseId,
          input.recoveryOperationId ?? null,
          predecessorRow?.id ?? null,
          input.attemptError ?? input.reason ?? null,
          evidenceJson,
          evidenceHash,
          terminalizedAt,
          now,
        );

        // Phase 188: commit artifacts inside the same transaction as the
        // attempt / job / event / provenance writes above. Any artifact
        // that is not bound to this exact attempt or job aborts the whole
        // transaction -- no partial artifact publication is possible.
        if (input.artifacts && input.artifacts.length > 0) {
          for (const art of input.artifacts) {
            if (!art.attemptId || art.attemptId !== input.attemptId) {
              result = { ok: false, reason: "STATE_MISMATCH" as any };
              throw new AbortTx();
            }
            if (art.jobId && art.jobId !== input.jobId) {
              result = { ok: false, reason: "STATE_MISMATCH" as any };
              throw new AbortTx();
            }
            await tx.prepareAsync(
              "INSERT INTO execution_artifacts " +
              "(artifact_id, job_id, release_id, attempt_id, name, type, size_bytes, " +
              " checksum, storage_ref, metadata, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              art.artifactId,
              art.jobId ?? input.jobId,
              art.releaseId ?? null,
              art.attemptId,
              art.name,
              art.type,
              art.sizeBytes ?? null,
              art.checksum,
              art.storageRef ?? null,
              art.metadata ? JSON.stringify(art.metadata) : null,
              art.createdAt,
            );
          }
          await this.addEventOnEngine(tx, {
            eventId: `evt_artifacts_${input.jobId}_${now}_${Math.random().toString(36).slice(2, 10)}`,
            jobId: input.jobId,
            eventType: "execution.completion.artifacts_committed",
            payload: {
              attemptId: input.attemptId,
              leaseId: input.leaseId,
              workerId: input.workerId,
              artifactCount: input.artifacts.length,
              artifactIds: input.artifacts.map((a) => a.artifactId),
            },
            createdAt: now,
          } as ExecutionEvent);
        }
        // Phase 188: finalize the lease. Once the attempt is terminal the
        // lease can no longer authorize execution. We RELEASE it (not EXPIRED)
        // so the fence model treats this as a controlled terminalization.
        await tx.prepareAsync(
          "UPDATE execution_leases SET status = 'RELEASED', released_at = ? " +
          "WHERE lease_id = ? AND status = 'ACTIVE'",
        ).run(now, input.leaseId);

        await tx.prepareAsync(
          "UPDATE execution_jobs SET current_lease_id = NULL, updated_at = ? " +
          "WHERE id = ? AND current_lease_id = ?",
        ).run(now, input.jobId, input.leaseId);
        const attemptAfter = await tx.prepareAsync(
          "SELECT * FROM execution_attempts WHERE id = ?",
        ).get<any>(input.attemptId);
        result = {
          ok: true, applied: true, idempotent: false,
          attempt: this.mapAttempt(attemptAfter),
          jobStatus: input.newJobStatus,
        };
      });
    } catch (err) {
      if (!(err instanceof AbortTx)) throw err;
    }
    return result;
  }

  listAttemptsForJob(jobId: string): ExecutionAttempt[] {
    const rows = this.db.prepare(
      "SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number"
    ).all(jobId);
    return rows.map((row: any) => this.mapAttempt(row));
  }

  // ---------- Workers ----------
  registerWorker(worker: ExecutionWorker): void {
    this.db.prepare(`
      INSERT INTO execution_workers (
        worker_id, hostname, capabilities, status, last_heartbeat_at,
        current_job_id, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      worker.workerId,
      worker.hostname,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.registeredAt
    );
  }

  updateWorker(worker: ExecutionWorker): void {
    this.db.prepare(`
      UPDATE execution_workers SET
        hostname = ?, capabilities = ?, status = ?,
        last_heartbeat_at = ?, current_job_id = ?
      WHERE worker_id = ?
    `).run(
      worker.hostname,
      worker.capabilities ? JSON.stringify(worker.capabilities) : null,
      worker.status,
      worker.lastHeartbeatAt,
      worker.currentJobId,
      worker.workerId
    );
  }

  getWorker(workerId: string): ExecutionWorker | undefined {
    const row = this.db.prepare("SELECT * FROM execution_workers WHERE worker_id = ?").get(workerId);
    return row ? this.mapWorker(row) : undefined;
  }

  listWorkers(): ExecutionWorker[] {
    return this.db.prepare("SELECT * FROM execution_workers").all().map(this.mapWorker);
  }

  listWorkersByStatus(status: string): ExecutionWorker[] {
    return this.db.prepare("SELECT * FROM execution_workers WHERE status = ?").all(status).map(this.mapWorker);
  }

  // ---------- Leases ----------
  /**
   * Phase 142: atomic claim of a QUEUED job Ã¢â‚¬â€ single SQLite transaction.
   *
   * Every durable step executes directly inside the transaction. This method
   * MUST NOT call transitionExecution(); doing so would create a nested
   * transaction boundary and break the crash-safety guarantee.
   *
   *   1. Guard (exists, QUEUED, not cancelled, no current_lease_id)
   *   2. Expire stale ACTIVE leases for this job
   *   3. INSERT new ACTIVE lease
   *   4. UPDATE job to CLAIMED + bind current_lease_id (CAS, 1 row required)
   *   5. INSERT durable execution.transition.claimed event via addEvent()
   */
  atomicClaimJob(input: {
    jobId: string;
    workerId: string;
    durationMs: number;
  }): {
    claimed: boolean;
    lease?: ExecutionLease;
    reason?: AtomicClaimRejectReason;
  } {
    const now = Date.now();
    const lease: ExecutionLease = {
      leaseId: "lease_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 10),
      jobId: input.jobId,
      workerId: input.workerId,
      acquiredAt: now,
      expiresAt: now + input.durationMs,
      status: "ACTIVE",
    };

    const run = (): void => {
      // 1. Guard.
      const row = this.db.prepare(
        "SELECT status, cancellation_requested, current_lease_id FROM execution_jobs WHERE id = ?"
      ).get(input.jobId) as
        | { status: string; cancellation_requested: number; current_lease_id: string | null }
        | undefined;

      if (!row) throw new AtomicClaimReject("NOT_QUEUED");
      if (row.cancellation_requested) throw new AtomicClaimReject("CANCELLED");
      if (row.status !== "QUEUED") throw new AtomicClaimReject("NOT_QUEUED");
      if (row.current_lease_id) throw new AtomicClaimReject("ALREADY_LEASED");

      // 2. Expire stale ACTIVE leases for this job only.
      this.db.prepare(
        "UPDATE execution_leases SET status = 'EXPIRED', released_at = ? " +
        "WHERE job_id = ? AND status = 'ACTIVE' AND expires_at <= ?"
      ).run(now, input.jobId, now);

      // 3. INSERT new ACTIVE lease.
      try {
        this.db.prepare(
          "INSERT INTO execution_leases (lease_id, job_id, worker_id, acquired_at, expires_at, renewed_at, released_at, status) " +
          "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE')"
        ).run(lease.leaseId, lease.jobId, lease.workerId, lease.acquiredAt, lease.expiresAt);
      } catch (err: any) {
        if (err && (err.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(String(err.message)))) {
          throw new AtomicClaimReject("LEASE_CONFLICT");
        }
        throw err;
      }

      if (typeof this.__testPhase142Hook === "function") {
        this.__testPhase142Hook("afterLeaseInsert");
      }

      // 4. CAS job UPDATE Ã¢â‚¬â€ direct statement, no nested tx.
      const upd = this.db.prepare(
        "UPDATE execution_jobs SET status = 'CLAIMED', updated_at = ?, current_lease_id = ? " +
        "WHERE id = ? AND status = 'QUEUED' AND cancellation_requested = 0 AND current_lease_id IS NULL"
      ).run(now, lease.leaseId, input.jobId);
      if ((upd.changes ?? 0) !== 1) throw new AtomicClaimReject("TRANSITION_FAILED");

      if (typeof this.__testPhase142Hook === "function") {
        this.__testPhase142Hook("afterJobUpdate");
      }

      // 5. Durable event INSERT Ã¢â‚¬â€ addEvent is a direct INSERT (no tx).
      this.addEvent({
        eventId: "evt_" + input.jobId + "_" + now + "_" + Math.random().toString(36).slice(2, 10),
        jobId: input.jobId,
        eventType: "execution.transition.claimed",
        payload: {
          from: "QUEUED",
          to: "CLAIMED",
          actor: "system",
          reason: "LEASE_ACQUIRED",
          workerId: input.workerId,
          leaseId: lease.leaseId,
        },
        createdAt: now,
      });
    };

    try {
      const maybeTx: any = (this.db as any).transaction(run);
      if (typeof maybeTx === "function") maybeTx();
      // else: SQLiteEngine executed run() eagerly inside a transaction.
      return { claimed: true, lease };
    } catch (err) {
      if (err instanceof AtomicClaimReject) return { claimed: false, reason: err.reason };
      throw err;
    }
  }
  acquireLease(lease: ExecutionLease): { acquired: boolean; existingLease?: ExecutionLease } {
    try {
      this.db.prepare(`
        INSERT INTO execution_leases (
          lease_id, job_id, worker_id, acquired_at, expires_at,
          renewed_at, released_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId,
        lease.jobId,
        lease.workerId,
        lease.acquiredAt,
        lease.expiresAt,
        lease.renewedAt,
        lease.releasedAt ?? null,
        lease.status
      );
      return { acquired: true };
    } catch (err: any) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(err.message)) {
        // Phase 127 STEP 5: exclude expired rows so a dead worker's stale
        // ACTIVE lease does not block reacquisition until recovery sweeps.
        const existing = this.getActiveNonExpiredLeaseForJob(lease.jobId, lease.acquiredAt);
        return { acquired: false, existingLease: existing };
      }
      throw err;
    }
  }

  updateLease(lease: ExecutionLease): void {
    this.db.prepare(`
      UPDATE execution_leases SET
        renewed_at = ?, released_at = ?, status = ?, expires_at = ?
      WHERE lease_id = ?
    `).run(
      lease.renewedAt ?? null,
      lease.releasedAt ?? null,
      lease.status,
      lease.expiresAt,
      lease.leaseId
    );
  }

  /**
   * Phase 126: atomically renew a lease only while the caller still owns
   * an unexpired ACTIVE lease. This closes the read/check/write race where
   * another worker could acquire the job between getLease() and updateLease().
   */
  renewLeaseAsOwner(
    leaseId: string,
    workerId: string,
    renewedAt: number,
    expiresAt: number,
    now: number
  ): boolean {
    const result = this.db.prepare(`
      UPDATE execution_leases SET
        renewed_at = ?,
        expires_at = ?
      WHERE lease_id = ?
        AND worker_id = ?
        AND status = 'ACTIVE'
        AND expires_at > ?
    `).run(
      renewedAt,
      expiresAt,
      leaseId,
      workerId,
      now
    );

    return result.changes === 1;
  }
  getLease(leaseId: string): ExecutionLease | undefined {
    const row = this.db.prepare("SELECT * FROM execution_leases WHERE lease_id = ?").get(leaseId);
    return row ? this.mapLease(row) : undefined;
  }

  getActiveLeaseForJob(jobId: string): ExecutionLease | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'"
    ).get(jobId);
    return row ? this.mapLease(row) : undefined;
  }

  getActiveNonExpiredLeaseForJob(jobId: string, now: number = Date.now()): ExecutionLease | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE' AND expires_at > ?"
    ).get(jobId, now);
    return row ? this.mapLease(row) : undefined;
  }

  listExpiredLeases(now: number): ExecutionLease[] {
    return this.db.prepare(
      "SELECT * FROM execution_leases WHERE status = 'ACTIVE' AND expires_at <= ?"
    ).all(now).map(this.mapLease);
  }

  /**
   * Clears the job's current_lease_id if it still points at the given
   * (released/expired) lease.  Called from LeaseManager.releaseLease so the
   * durable job row matches the in-memory state after release.  CAS on the
   * previous lease id ensures a concurrent new claim is never clobbered.
   */
  clearJobLeaseByLeaseId(leaseId: string): void {
    this.db.prepare(`
      UPDATE execution_jobs SET current_lease_id = NULL
      WHERE current_lease_id = ?
    `).run(leaseId);
  }

  // ---------- Artifacts ----------
  /**
   * Phase 136: worker-authoritative artifact registration. Requires the
   * caller to hold an ACTIVE, unexpired lease matching (lease_id, worker_id,
   * job_id). A stale worker is rejected and no artifact row is written.
   * System/recovery callers that do not carry a worker lease continue to use
   * the unfenced addArtifact().
   */
  addArtifactAsOwner(
    artifact: ArtifactRecord,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): { added: boolean; reason?: "WORKER_OWNERSHIP_LOST" | "JOB_ID_REQUIRED" } {
    if (!artifact.jobId) {
      return { added: false, reason: "JOB_ID_REQUIRED" };
    }
    const owned = this.db.prepare(`
      SELECT 1 FROM execution_leases
      WHERE lease_id = ? AND worker_id = ? AND job_id = ?
        AND status = 'ACTIVE' AND expires_at > ?
    `).get(leaseId, workerId, artifact.jobId, now);
    if (!owned) {
      return { added: false, reason: "WORKER_OWNERSHIP_LOST" };
    }
    this.addArtifact(artifact);
    return { added: true };
  }

  addArtifact(artifact: ArtifactRecord): void {
    this.db.prepare(`
      INSERT INTO execution_artifacts (
        artifact_id, job_id, release_id, attempt_id, name, type, size_bytes,
        checksum, storage_ref, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.artifactId,
      artifact.jobId,
      artifact.releaseId,
      artifact.attemptId ?? null,
      artifact.name,
      artifact.type,
      artifact.sizeBytes,
      artifact.checksum,
      artifact.storageRef,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null,
      artifact.createdAt
    );
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_artifacts WHERE artifact_id = ?").get(artifactId);
    return row ? this.mapArtifact(row) : undefined;
  }

  // ---------- Releases ----------
  addRelease(release: ReleaseRecord): void {
    this.db.prepare(`
      INSERT INTO execution_releases (
        release_id, version, build_info, artifact_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      release.releaseId,
      release.version,
      release.buildInfo ? JSON.stringify(release.buildInfo) : null,
      release.artifactId,
      release.status,
      release.createdAt,
      release.updatedAt
    );
  }

  updateRelease(release: ReleaseRecord): void {
    this.db.prepare(`
      UPDATE execution_releases SET
        build_info = ?, artifact_id = ?, status = ?, updated_at = ?
      WHERE release_id = ?
    `).run(
      release.buildInfo ? JSON.stringify(release.buildInfo) : null,
      release.artifactId,
      release.status,
      release.updatedAt,
      release.releaseId
    );
  }

  getRelease(releaseId: string): ReleaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_releases WHERE release_id = ?").get(releaseId);
    return row ? this.mapRelease(row) : undefined;
  }

  // ---------- Deployments ----------
  addDeployment(deployment: DeploymentRecord): void {
    this.db.prepare(`
      INSERT INTO execution_deployments (
        deployment_id, release_id, environment, status, created_at,
        updated_at, rollback_deployment_id, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deployment.deploymentId,
      deployment.releaseId,
      deployment.environment,
      deployment.status,
      deployment.createdAt,
      deployment.updatedAt,
      deployment.rollbackDeploymentId,
      deployment.evidence ? JSON.stringify(deployment.evidence) : null
    );
  }

  updateDeployment(deployment: DeploymentRecord): void {
    this.db.prepare(`
      UPDATE execution_deployments SET
        status = ?, updated_at = ?, rollback_deployment_id = ?, evidence = ?
      WHERE deployment_id = ?
    `).run(
      deployment.status,
      deployment.updatedAt,
      deployment.rollbackDeploymentId,
      deployment.evidence ? JSON.stringify(deployment.evidence) : null,
      deployment.deploymentId
    );
  }

  getDeployment(deploymentId: string): DeploymentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM execution_deployments WHERE deployment_id = ?").get(deploymentId);
    return row ? this.mapDeployment(row) : undefined;
  }

  // ---------- Approvals ----------
  addApproval(approval: ApprovalRequest): void {
    this.db.prepare(`
      INSERT INTO execution_approvals (
        approval_id, deployment_id, release_id, environment, requested_action,
        decision, decided_at, decided_by, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.approvalId,
      approval.deploymentId,
      approval.releaseId,
      approval.environment,
      approval.requestedAction,
      approval.decision,
      approval.decidedAt,
      approval.decidedBy,
      approval.reason,
      approval.createdAt
    );
  }

  updateApproval(approval: ApprovalRequest): void {
    this.db.prepare(`
      UPDATE execution_approvals SET
        decision = ?, decided_at = ?, decided_by = ?, reason = ?
      WHERE approval_id = ?
    `).run(
      approval.decision,
      approval.decidedAt,
      approval.decidedBy,
      approval.reason,
      approval.approvalId
    );
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM execution_approvals WHERE approval_id = ?").get(approvalId);
    return row ? this.mapApproval(row) : undefined;
  }

  // ---------- Events ----------
  /**
   * Phase 165: retrieve terminal outcome provenance.
   *
   * These methods are read-only. The provenance row is written atomically
   * inside completeAttemptAndTransitionJob's transaction, and there is no
   * UPDATE or DELETE path, so returned rows are immutable.
   */
  // ---------- Phase 165 query surface (typed) ----------

  getOutcomeProvenanceByAttempt(attemptId: string): ExecutionOutcomeProvenance | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE attempt_id = ?"
    ).get(attemptId) as any;
    if (!row) return undefined;
    return this.mapOutcomeProvenance(row);
  }

  getOutcomeProvenanceByJob(jobId: string): ExecutionOutcomeProvenance[] {
    const rows = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE job_id = ? " +
      "ORDER BY terminalized_at ASC, attempt_number ASC, provenance_id ASC"
    ).all(jobId) as any[];
    return rows.map((r: any) => this.mapOutcomeProvenance(r));
  }

  getRetryLineage(jobId: string): ExecutionOutcomeProvenance[] {
    const rows = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE job_id = ? " +
      "ORDER BY attempt_number ASC, provenance_id ASC"
    ).all(jobId) as any[];
    return rows.map((r: any) => this.mapOutcomeProvenance(r));
  }

  getOutcomeProvenanceById(provenanceId: string): ExecutionOutcomeProvenance | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE provenance_id = ?"
    ).get(provenanceId) as any;
    if (!row) return undefined;
    return this.mapOutcomeProvenance(row);
  }

  getOutcomeProvenanceByRecoveryOperation(
    recoveryOperationId: string
  ): ExecutionOutcomeProvenance | undefined {
    const row = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE recovery_operation_id = ? " +
      "ORDER BY terminalized_at ASC LIMIT 1"
    ).get(recoveryOperationId) as any;
    if (!row) return undefined;
    return this.mapOutcomeProvenance(row);
  }

  // ---------- Phase 166: durable audit query + verification surface ----------
  //
  // query* methods cross-check the provenance row against its durable source
  // execution_attempts row before returning. A result is either provably
  // consistent ("ok"), absent ("not_found"), or provably inconsistent
  // ("integrity_failure"). They never repair, never coerce a broken row into
  // "ok", and never write to the database.

  queryProvenanceByAttempt(attemptId: string): ProvenanceQueryResult {
    const raw = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE attempt_id = ?"
    ).get(attemptId) as any;
    if (!raw) return { kind: "not_found" };
    return this.validateProvenanceRow(raw);
  }

  queryProvenanceById(provenanceId: string): ProvenanceQueryResult {
    const raw = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE provenance_id = ?"
    ).get(provenanceId) as any;
    if (!raw) return { kind: "not_found" };
    return this.validateProvenanceRow(raw);
  }

  queryProvenanceByRecoveryOperation(recoveryOperationId: string): ProvenanceQueryResult {
    const raw = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE recovery_operation_id = ? " +
      "ORDER BY terminalized_at ASC LIMIT 1"
    ).get(recoveryOperationId) as any;
    if (!raw) return { kind: "not_found" };
    return this.validateProvenanceRow(raw);
  }

  queryProvenanceByJob(jobId: string):
    | { kind: "ok"; records: ExecutionOutcomeProvenance[] }
    | { kind: "integrity_failure"; failure: ProvenanceIntegrityFailure } {
    const rows = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE job_id = ? " +
      "ORDER BY terminalized_at ASC, attempt_number ASC, provenance_id ASC"
    ).all(jobId) as any[];
    const records: ExecutionOutcomeProvenance[] = [];
    for (const row of rows) {
      const res = this.validateProvenanceRow(row);
      if (res.kind === "integrity_failure") return res;
      if (res.kind === "ok") records.push(res.record);
    }
    return { kind: "ok", records };
  }

  queryRetryLineage(jobId: string): RetryLineageResult {
    const rows = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE job_id = ? " +
      "ORDER BY attempt_number ASC, provenance_id ASC"
    ).all(jobId) as any[];
    const records: ExecutionOutcomeProvenance[] = [];
    for (const row of rows) {
      const res = this.validateProvenanceRow(row);
      if (res.kind === "integrity_failure") return res;
      if (res.kind === "ok") records.push(res.record);
    }
    const lineageFailure = validateRetryLineage(records);
    if (lineageFailure) return { kind: "integrity_failure", failure: lineageFailure };
    const steps: RetryLineageStep[] = records.map((r) => ({
      provenance: r,
      predecessorAttemptId: r.predecessorAttemptId,
    }));
    return { kind: "ok", steps };
  }

  pageProvenanceByJob(
    jobId: string,
    limit: number,
    cursor: { terminalizedAt: number; provenanceId: string } | null,
  ):
    | { kind: "ok"; records: ExecutionOutcomeProvenance[]; hasMore: boolean }
    | { kind: "integrity_failure"; failure: ProvenanceIntegrityFailure } {
    const fetchLimit = limit + 1;
    let rows: any[];
    if (cursor) {
      rows = this.db.prepare(
        "SELECT * FROM execution_outcome_provenance " +
        "WHERE job_id = ? AND (terminalized_at > ? OR (terminalized_at = ? AND provenance_id > ?)) " +
        "ORDER BY terminalized_at ASC, provenance_id ASC LIMIT ?"
      ).all(jobId, cursor.terminalizedAt, cursor.terminalizedAt, cursor.provenanceId, fetchLimit) as any[];
    } else {
      rows = this.db.prepare(
        "SELECT * FROM execution_outcome_provenance WHERE job_id = ? " +
        "ORDER BY terminalized_at ASC, provenance_id ASC LIMIT ?"
      ).all(jobId, fetchLimit) as any[];
    }
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records: ExecutionOutcomeProvenance[] = [];
    for (const row of pageRows) {
      const res = this.validateProvenanceRow(row);
      if (res.kind === "integrity_failure") return res;
      if (res.kind === "ok") records.push(res.record);
    }
    return { kind: "ok", records, hasMore };
  }
  verifyProvenanceByAttempt(
    attemptId: string
  ): ProvenanceVerificationResult | { kind: "not_found" } {
    const raw = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE attempt_id = ?"
    ).get(attemptId) as any;
    if (!raw) return { kind: "not_found" };
    return verifyProvenanceEvidenceHash(
      this.mapOutcomeProvenance(raw),
      raw.evidence_json ?? null
    );
  }

  verifyProvenanceById(
    provenanceId: string
  ): ProvenanceVerificationResult | { kind: "not_found" } {
    const raw = this.db.prepare(
      "SELECT * FROM execution_outcome_provenance WHERE provenance_id = ?"
    ).get(provenanceId) as any;
    if (!raw) return { kind: "not_found" };
    return verifyProvenanceEvidenceHash(
      this.mapOutcomeProvenance(raw),
      raw.evidence_json ?? null
    );
  }

  private validateProvenanceRow(raw: any): ProvenanceQueryResult {
    const record = this.mapOutcomeProvenance(raw);
    const attempt = this.getAttempt(record.attemptId);
    const failure = validateProvenanceAgainstAttempt(record, attempt);
    if (failure) return { kind: "integrity_failure", failure };
    return { kind: "ok", record };
  }

  private mapOutcomeProvenance(row: any): ExecutionOutcomeProvenance {
    let evidence: string[] | null = null;
    if (row.evidence_json) {
      try { evidence = JSON.parse(row.evidence_json); }
      catch { evidence = null; }
    }
    return {
      provenanceId: row.provenance_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      attemptNumber: row.attempt_number,
      outcome: row.outcome,
      previousState: row.previous_state,
      workerId: row.worker_id ?? null,
      leaseId: row.lease_id ?? null,
      recoveryOperationId: row.recovery_operation_id ?? null,
      predecessorAttemptId: row.predecessor_attempt_id ?? null,
      reason: row.reason ?? null,
      evidence,
      evidenceHash: row.evidence_hash,
      terminalizedAt: row.terminalized_at,
      createdAt: row.created_at,
    };
  }

  addEvent(event: ExecutionEvent): void {
    this.db.prepare(`
      INSERT INTO execution_events (event_id, job_id, deployment_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.jobId,
      event.deploymentId,
      event.eventType,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt
    );
  }

  // ---------- Mapping Helpers ----------
  private mapJob(row: any): ExecutionJob {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      jobType: row.job_type,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      status: row.status,
      retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) : undefined,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      currentLeaseId: row.current_lease_id,
      cancellationRequested: !!row.cancellation_requested,
      cancellationAcknowledged: !!row.cancellation_acknowledged,
    };
  }

  private mapAttempt(row: any): ExecutionAttempt {
    return {
      id: row.id,
      jobId: row.job_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      workerId: row.worker_id,
      leaseId: row.lease_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      heartbeatAt: row.heartbeat_at ? Number(row.heartbeat_at) : undefined,
      createdAt: row.created_at,
    };
  }

  private mapWorker(row: any): ExecutionWorker {
    return {
      workerId: row.worker_id,
      hostname: row.hostname,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
      currentJobId: row.current_job_id,
      registeredAt: row.registered_at,
    };
  }

  // ============================================================
  // Phase 183b: async persistence for release/deployment intents.
  // Same SQL semantics as the sync siblings; routes through this.asyncDb.
  // Shared mode uses these; sync mode continues to use the sync methods.
  // ============================================================

  async createReleaseIntentIdempotentAsync(
    input: Omit<ReleaseDeploymentIntent, "status" | "deploymentId" | "failureReason" | "recoveryReason" | "leasedBy" | "leaseExpiresAt" | "createdAt" | "updatedAt">,
    now: number = Date.now(),
  ): Promise<{ intent: ReleaseDeploymentIntent; created: boolean; conflict?: boolean }> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      INSERT INTO release_deployment_intents (
        intent_key, release_id, execution_id, artifact_id, artifact_digest,
        commit_sha, environment, image_repository, image_tag, image_id,
        image_digest, container_name, container_port, status,
        deployment_id, failure_reason, recovery_reason, leased_by, lease_expires_at,
        created_at, updated_at, project_id, intent_kind,
        rollback_target_release_id, rollback_job_id, attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'DEPLOYMENT_INTENT_CREATED',
                NULL, NULL, NULL, NULL, NULL,
                ?, ?, ?, ?,
                ?, ?, ?)
      ON CONFLICT (intent_key) DO NOTHING
    `).run(
      input.intentKey,
      input.releaseId,
      input.executionId,
      input.artifactId,
      input.artifactDigest,
      input.commitSha,
      input.environment,
      input.imageRepository,
      input.imageTag,
      input.imageId ?? null,
      input.imageDigest,
      input.containerName,
      input.containerPort,
      now,
      now,
      input.projectId ?? null,
      input.intentKind ?? "DEPLOY",
      input.rollbackTargetReleaseId ?? null,
      input.rollbackJobId ?? null,
      input.attemptId ?? null,
    );
    const existing = await this.getReleaseIntentAsync(input.intentKey);
    if (!existing) throw new Error("release intent missing after INSERT ON CONFLICT DO NOTHING");
    // Phase 190: detect conflicting reuse of the same intent_key. ON CONFLICT
    // DO NOTHING preserves idempotency for exact-match retries, but if any
    // immutable provenance field differs, the caller must be told so they do
    // not silently continue against the wrong release.
    const inputKind = input.intentKind ?? "DEPLOY";
    const existingKind = existing.intentKind ?? "DEPLOY";
    const conflict =
      existing.releaseId !== input.releaseId ||
      existing.artifactId !== input.artifactId ||
      existing.environment !== input.environment ||
      (existing.attemptId ?? null) !== (input.attemptId ?? null) ||
      existingKind !== inputKind;
    return { intent: existing, created: r.changes > 0, conflict: conflict || undefined };
  }

  async getReleaseIntentAsync(intentKey: string): Promise<ReleaseDeploymentIntent | undefined> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get<any>(intentKey);
    return row ? this.mapReleaseIntent(row) : undefined;
  }

  async updateReleaseIntentStatusAsync(
    intentKey: string,
    status: ReleaseIntentStatus,
    patch: {
      deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null;
      provider?: string | null; providerStatus?: string | null; providerDeploymentId?: string | null;
      startedAt?: number | null; completedAt?: number | null; reconciledAt?: number | null;
      recoveryAttempts?: number | null; nextRetryAt?: number | null; lastFailureClass?: string | null;
      reconciliationEvidence?: string | null;
    } = {},
  ): Promise<ReleaseDeploymentIntent | undefined> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        status = ?,
        deployment_id = COALESCE(?, deployment_id),
        failure_reason = COALESCE(?, failure_reason),
        recovery_reason = COALESCE(?, recovery_reason),
        provider = COALESCE(?, provider),
        provider_status = COALESCE(?, provider_status),
        provider_deployment_id = COALESCE(?, provider_deployment_id),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        reconciled_at = COALESCE(?, reconciled_at),
        recovery_attempts = COALESCE(?, recovery_attempts),
        next_retry_at = COALESCE(?, next_retry_at),
        last_failure_class = COALESCE(?, last_failure_class),
        reconciliation_evidence = COALESCE(?, reconciliation_evidence),
        updated_at = ?
      WHERE intent_key = ?
    `).run(
      status,
      patch.deploymentId ?? null,
      patch.failureReason ?? null,
      patch.recoveryReason ?? null,
      patch.provider ?? null,
      patch.providerStatus ?? null,
      patch.providerDeploymentId ?? null,
      patch.startedAt ?? null,
      patch.completedAt ?? null,
      patch.reconciledAt ?? null,
      patch.recoveryAttempts ?? null,
      patch.nextRetryAt ?? null,
      patch.lastFailureClass ?? null,
      patch.reconciliationEvidence ?? null,
      now,
      intentKey,
    );
    return this.getReleaseIntentAsync(intentKey);
  }

  async updateReleaseIntentStatusIfOwnedAsync(
    intentKey: string,
    status: ReleaseIntentStatus,
    workerId: string,
    patch: {
      deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null;
      provider?: string | null; providerStatus?: string | null; providerDeploymentId?: string | null;
      startedAt?: number | null; completedAt?: number | null; reconciledAt?: number | null;
      recoveryAttempts?: number | null; nextRetryAt?: number | null; lastFailureClass?: string | null;
      reconciliationEvidence?: string | null;
    } = {},
    expectedStatuses?: ReleaseIntentStatus[],
  ): Promise<{ updated: boolean; intent: ReleaseDeploymentIntent | undefined }> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    let sql = `
      UPDATE release_deployment_intents SET
        status = ?,
        deployment_id = COALESCE(?, deployment_id),
        failure_reason = COALESCE(?, failure_reason),
        recovery_reason = COALESCE(?, recovery_reason),
        provider = COALESCE(?, provider),
        provider_status = COALESCE(?, provider_status),
        provider_deployment_id = COALESCE(?, provider_deployment_id),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        reconciled_at = COALESCE(?, reconciled_at),
        recovery_attempts = COALESCE(?, recovery_attempts),
        next_retry_at = COALESCE(?, next_retry_at),
        last_failure_class = COALESCE(?, last_failure_class),
        reconciliation_evidence = COALESCE(?, reconciliation_evidence),
        updated_at = ?
      WHERE intent_key = ?
        AND leased_by = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?
        AND (status NOT IN ('KNOWN_GOOD','FAILED','BLOCKED','CANCELLED','VERIFICATION_FAILED','UNKNOWN') OR status = ?)
    `;
    const params: unknown[] = [
      status,
      patch.deploymentId ?? null,
      patch.failureReason ?? null,
      patch.recoveryReason ?? null,
      patch.provider ?? null,
      patch.providerStatus ?? null,
      patch.providerDeploymentId ?? null,
      patch.startedAt ?? null,
      patch.completedAt ?? null,
      patch.reconciledAt ?? null,
      patch.recoveryAttempts ?? null,
      patch.nextRetryAt ?? null,
      patch.lastFailureClass ?? null,
      patch.reconciliationEvidence ?? null,
      now,
      intentKey,
      workerId,
      now,
      status,
    ];
    if (expectedStatuses && expectedStatuses.length > 0) {
      sql += " AND status IN (" + expectedStatuses.map(() => "?").join(",") + ")";
      params.push(...expectedStatuses);
    }
    const r = await engine.prepareAsync(sql).run(...params);
    return { updated: r.changes > 0, intent: await this.getReleaseIntentAsync(intentKey) };
  }

  async acquireReleaseIntentLeaseAsync(
    intentKey: string,
    workerId: string,
    durationMs: number = 120_000,
  ): Promise<{ acquired: boolean; holder: string | null; expiresAt: number | null }> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    const intent = await this.getReleaseIntentAsync(intentKey);
    if (!intent) return { acquired: false, holder: null, expiresAt: null };
    const leaseActive = intent.leasedBy !== null && intent.leaseExpiresAt !== null && intent.leaseExpiresAt > now;
    const sameHolder = intent.leasedBy === workerId;
    if (leaseActive && !sameHolder) {
      return { acquired: false, holder: intent.leasedBy, expiresAt: intent.leaseExpiresAt };
    }
    const expiresAt = now + durationMs;
    const r = await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        leased_by = ?, lease_expires_at = ?, updated_at = ?
      WHERE intent_key = ?
        AND (
          leased_by IS NULL
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ?
          OR leased_by = ?
        )
    `).run(workerId, expiresAt, now, intentKey, now, workerId);
    if (r.changes === 0) {
      const fresh = await this.getReleaseIntentAsync(intentKey);
      return { acquired: false, holder: fresh?.leasedBy ?? null, expiresAt: fresh?.leaseExpiresAt ?? null };
    }
    return { acquired: true, holder: workerId, expiresAt };
  }

  async renewReleaseIntentLeaseAsync(intentKey: string, workerId: string, durationMs: number): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    const expiresAt = now + durationMs;
    const r = await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        lease_expires_at = ?, updated_at = ?
      WHERE intent_key = ? AND leased_by = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
    `).run(expiresAt, now, intentKey, workerId, now);
    return r.changes > 0;
  }

  async releaseReleaseIntentLeaseAsync(intentKey: string, workerId: string): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const now = Date.now();
    const r = await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        leased_by = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE intent_key = ? AND leased_by = ?
    `).run(now, intentKey, workerId);
    return r.changes > 0;
  }

  async listReleaseIntentsByStatusAsync(status: ReleaseIntentStatus): Promise<ReleaseDeploymentIntent[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM release_deployment_intents WHERE status = ? ORDER BY created_at DESC",
    ).all<any>(status);
    return rows.map((r) => this.mapReleaseIntent(r));
  }

  async listRecoverableReleaseIntentsAsync(): Promise<ReleaseDeploymentIntent[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(`
      SELECT * FROM release_deployment_intents
      WHERE status IN ('PENDING','AUTHORIZED','DEPLOYMENT_INTENT_CREATED','DEPLOYING','HEALTH_CHECKING','SMOKE_TESTING','VERIFICATION_FAILED','ROLLING_BACK','RECOVERY_REQUIRED')
      ORDER BY created_at DESC
    `).all<any>();
    return rows.map((r) => this.mapReleaseIntent(r));
  }

  async requestIntentCancellationAsync(intentKey: string, now: number = Date.now()): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        cancel_requested_at = ?, updated_at = ?
      WHERE intent_key = ?
        AND cancel_requested_at IS NULL
        AND status NOT IN ('KNOWN_GOOD', 'FAILED', 'BLOCKED', 'CANCELLED')
    `).run(now, now, intentKey);
    return r.changes > 0;
  }

  async acknowledgeIntentCancellationAsync(intentKey: string, now: number = Date.now()): Promise<boolean> {
    const engine = this.requireAsyncDb();
    const r = await engine.prepareAsync(`
      UPDATE release_deployment_intents SET
        cancel_acknowledged_at = ?, updated_at = ?
      WHERE intent_key = ?
        AND cancel_requested_at IS NOT NULL
        AND cancel_acknowledged_at IS NULL
    `).run(now, now, intentKey);
    return r.changes > 0;
  }

  /* -------- Phase 103: durable release deployment intent -------- */

  private ensureIntentTable(): void {
    // Schema is owned by migration 146.
    // This compatibility method intentionally performs no runtime DDL.
  }
  /**
   * Idempotent create. INSERT OR IGNORE guarantees a race produces exactly one row.
   * Returns the row that now exists plus a flag indicating whether it was created.
   */
  createReleaseIntentIdempotent(
    input: Omit<ReleaseDeploymentIntent, "status" | "deploymentId" | "failureReason" | "recoveryReason" | "leasedBy" | "leaseExpiresAt" | "createdAt" | "updatedAt">,
  ): { intent: ReleaseDeploymentIntent; created: boolean } {
    this.ensureIntentTable();
    const now = Date.now();
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO release_deployment_intents (
        intent_key, release_id, execution_id, artifact_id, artifact_digest,
        commit_sha, environment, project_id, image_repository, image_tag, image_id,
          intent_kind, rollback_target_release_id, rollback_job_id,
        image_digest, container_name, container_port, status, deployment_id,
        failure_reason, recovery_reason, leased_by, lease_expires_at,
        attempt_id,
        created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEPLOYMENT_INTENT_CREATED', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
    `).run(
        input.intentKey,
        input.releaseId,
        input.executionId,
        input.artifactId,
        input.artifactDigest,
        input.commitSha,
        input.environment,
        input.projectId ?? null,
        input.imageRepository,
        input.imageTag,
        input.imageId,
        input.intentKind ?? "DEPLOY",
        input.rollbackTargetReleaseId ?? null,
        input.rollbackJobId ?? null,
        input.imageDigest,
        input.containerName,
        input.containerPort,
        input.attemptId ?? null,
        now,
        now,
      );
    const existing = this.getReleaseIntent(input.intentKey);
    if (!existing) throw new Error("release intent missing after INSERT OR IGNORE");
    return { intent: existing, created: (info.changes ?? 0) > 0 };
  }

  getReleaseIntent(intentKey: string): ReleaseDeploymentIntent | undefined {
    this.ensureIntentTable();
    const row = this.db.prepare("SELECT * FROM release_deployment_intents WHERE intent_key = ?").get(intentKey);
    return row ? this.mapReleaseIntent(row) : undefined;
  }

  updateReleaseIntentStatus(
    intentKey: string,
    status: ReleaseIntentStatus,
    patch: { deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null; provider?: string | null; providerStatus?: string | null; providerDeploymentId?: string | null; startedAt?: number | null; completedAt?: number | null; reconciledAt?: number | null; recoveryAttempts?: number | null; nextRetryAt?: number | null; lastFailureClass?: string | null; reconciliationEvidence?: string | null; lastRecoveryDecision?: string | null; lastRecoveryDecisionAt?: number | null } = {},
  ): ReleaseDeploymentIntent | undefined {
    this.ensureIntentTable();
    const now = Date.now();
    this.db.prepare(`
      UPDATE release_deployment_intents SET
        status = ?,
        deployment_id = COALESCE(?, deployment_id),
        failure_reason = COALESCE(?, failure_reason),
        recovery_reason = COALESCE(?, recovery_reason),
        provider = COALESCE(?, provider),
        provider_status = COALESCE(?, provider_status),
        provider_deployment_id = COALESCE(?, provider_deployment_id),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        reconciled_at = COALESCE(?, reconciled_at),
        recovery_attempts = COALESCE(?, recovery_attempts),
        next_retry_at = COALESCE(?, next_retry_at),
        last_failure_class = COALESCE(?, last_failure_class),
        reconciliation_evidence = COALESCE(?, reconciliation_evidence),
        last_recovery_decision = COALESCE(?, last_recovery_decision),
        last_recovery_decision_at = COALESCE(?, last_recovery_decision_at),
        updated_at = ?
      WHERE intent_key = ?
    `).run(
      status,
      patch.deploymentId ?? null,
      patch.failureReason ?? null,
      patch.recoveryReason ?? null,
      patch.provider ?? null,
      patch.providerStatus ?? null,
      patch.providerDeploymentId ?? null,
      patch.startedAt ?? null,
      patch.completedAt ?? null,
      patch.reconciledAt ?? null,
      patch.recoveryAttempts ?? null,
      patch.nextRetryAt ?? null,
      patch.lastFailureClass ?? null,
      patch.reconciliationEvidence ?? null,
      patch.lastRecoveryDecision ?? null,
      patch.lastRecoveryDecisionAt ?? null,
      now,
      intentKey,
    );
    return this.getReleaseIntent(intentKey);
  }

  /**
   * Phase 174: fenced transition. Only the current, non-expired lease owner
   * may mutate the intent, and (optionally) only when the current status is
   * in the expected set. Returns { updated: false } for a stale worker; the
   * caller MUST treat updated=false as fenced and stop.
   */
  updateReleaseIntentStatusIfOwned(
    intentKey: string,
    status: ReleaseIntentStatus,
    workerId: string,
    patch: { deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null; provider?: string | null; providerStatus?: string | null; providerDeploymentId?: string | null; startedAt?: number | null; completedAt?: number | null; reconciledAt?: number | null; recoveryAttempts?: number | null; nextRetryAt?: number | null; lastFailureClass?: string | null; reconciliationEvidence?: string | null; lastRecoveryDecision?: string | null; lastRecoveryDecisionAt?: number | null } = {},
    expectedStatuses?: ReleaseIntentStatus[],
  ): { updated: boolean; intent: ReleaseDeploymentIntent | undefined } {
    this.ensureIntentTable();
    const now = Date.now();
    let sql = `
      UPDATE release_deployment_intents SET
        status = ?,
        deployment_id = COALESCE(?, deployment_id),
        failure_reason = COALESCE(?, failure_reason),
        recovery_reason = COALESCE(?, recovery_reason),
        provider = COALESCE(?, provider),
        provider_status = COALESCE(?, provider_status),
        provider_deployment_id = COALESCE(?, provider_deployment_id),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        reconciled_at = COALESCE(?, reconciled_at),
        recovery_attempts = COALESCE(?, recovery_attempts),
        next_retry_at = COALESCE(?, next_retry_at),
        last_failure_class = COALESCE(?, last_failure_class),
        reconciliation_evidence = COALESCE(?, reconciliation_evidence),
        last_recovery_decision = COALESCE(?, last_recovery_decision),
        last_recovery_decision_at = COALESCE(?, last_recovery_decision_at),
        updated_at = ?
      WHERE intent_key = ?
        AND leased_by = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?
    `;
    const params: any[] = [
      status,
      patch.deploymentId ?? null,
      patch.failureReason ?? null,
      patch.recoveryReason ?? null,
      patch.provider ?? null,
      patch.providerStatus ?? null,
      patch.providerDeploymentId ?? null,
      patch.startedAt ?? null,
      patch.completedAt ?? null,
      patch.reconciledAt ?? null,
      patch.recoveryAttempts ?? null,
      patch.nextRetryAt ?? null,
      patch.lastFailureClass ?? null,
      patch.reconciliationEvidence ?? null,
      patch.lastRecoveryDecision ?? null,
      patch.lastRecoveryDecisionAt ?? null,
      now,
      intentKey,
      workerId,
      now,
    ];
    if (expectedStatuses && expectedStatuses.length > 0) {
      sql += " AND status IN (" + expectedStatuses.map(() => "?").join(",") + ")";
      params.push(...expectedStatuses);
    }
    const info = this.db.prepare(sql).run(...params);
    const updated = (info.changes ?? 0) > 0;
    return { updated, intent: this.getReleaseIntent(intentKey) };
  }

  /**
   * Optimistic-lock lease. Acquires iff: no active lease OR lease expired OR caller already holds it.
   * Returns the outcome; caller MUST inspect `acquired`.
   */
  acquireReleaseIntentLease(
    intentKey: string,
    workerId: string,
    durationMs: number,
  ): { acquired: boolean; holder: string | null; expiresAt: number | null } {
    this.ensureIntentTable();
    const now = Date.now();
    const intent = this.getReleaseIntent(intentKey);
    if (!intent) return { acquired: false, holder: null, expiresAt: null };
    const leaseActive = intent.leasedBy !== null && intent.leaseExpiresAt !== null && intent.leaseExpiresAt > now;
    const sameHolder = intent.leasedBy === workerId;
    if (leaseActive && !sameHolder) {
      return { acquired: false, holder: intent.leasedBy, expiresAt: intent.leaseExpiresAt };
    }
    const expiresAt = now + durationMs;
    const info = this.db.prepare(`
      UPDATE release_deployment_intents SET
        leased_by = ?, lease_expires_at = ?, updated_at = ?
      WHERE intent_key = ?
        AND (
          leased_by IS NULL
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ?
          OR leased_by = ?
        )
    `).run(workerId, expiresAt, now, intentKey, now, workerId);
    if ((info.changes ?? 0) === 0) {
      const fresh = this.getReleaseIntent(intentKey);
      return { acquired: false, holder: fresh?.leasedBy ?? null, expiresAt: fresh?.leaseExpiresAt ?? null };
    }
    return { acquired: true, holder: workerId, expiresAt };
  }

  renewReleaseIntentLease(intentKey: string, workerId: string, durationMs: number): boolean {
    this.ensureIntentTable();
    const now = Date.now();
    const expiresAt = now + durationMs;
    const info = this.db.prepare(`
      UPDATE release_deployment_intents SET
        lease_expires_at = ?, updated_at = ?
      WHERE intent_key = ? AND leased_by = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
    `).run(expiresAt, now, intentKey, workerId, now);
    return (info.changes ?? 0) > 0;
  }

  releaseReleaseIntentLease(intentKey: string, workerId: string): boolean {
    this.ensureIntentTable();
    const now = Date.now();
    const info = this.db.prepare(`
      UPDATE release_deployment_intents SET
        leased_by = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE intent_key = ? AND leased_by = ?
    `).run(now, intentKey, workerId);
    return (info.changes ?? 0) > 0;
  }

  listReleaseIntentsByStatus(status: ReleaseIntentStatus): ReleaseDeploymentIntent[] {
    this.ensureIntentTable();
    const rows = this.db.prepare(
      "SELECT * FROM release_deployment_intents WHERE status = ? ORDER BY created_at DESC"
    ).all(status);
    return (rows as any[]).map((r) => this.mapReleaseIntent(r));
  }

  listRecoverableReleaseIntents(): ReleaseDeploymentIntent[] {
    this.ensureIntentTable();
    const rows = this.db.prepare(`
      SELECT * FROM release_deployment_intents
      WHERE status IN ('PENDING','AUTHORIZED','DEPLOYMENT_INTENT_CREATED','DEPLOYING','HEALTH_CHECKING','SMOKE_TESTING','VERIFICATION_FAILED','ROLLING_BACK','RECOVERY_REQUIRED')
      ORDER BY created_at DESC
    `).all();
    return (rows as any[]).map((r) => this.mapReleaseIntent(r));
  }

  /* -------- Phase 138: durable production execution authorizations -------- */

  private ensureAuthorizationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS production_execution_authorizations (
        authorization_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        environment TEXT NOT NULL,
        security_decision_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        execution_id TEXT,
        project_id TEXT,
        image_repository TEXT,
        image_tag TEXT,
        image_id TEXT,
        container_name TEXT,
        container_port INTEGER,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_attempt_id TEXT,
        revoked_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prod_auth_release_env
        ON production_execution_authorizations(release_id, environment);
      CREATE INDEX IF NOT EXISTS idx_prod_auth_consumed_by
        ON production_execution_authorizations(consumed_by_attempt_id);
      CREATE INDEX IF NOT EXISTS idx_prod_auth_expires
        ON production_execution_authorizations(expires_at);
    `);
  }

  createProductionAuthorization(auth: StoredProductionAuthorization): void {
    this.ensureAuthorizationTable();
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO production_execution_authorizations (
        authorization_id, release_id, artifact_id, artifact_digest, commit_sha,
        environment, security_decision_id, approval_id, execution_id, project_id,
        image_repository, image_tag, image_id, container_name, container_port,
        issued_at, expires_at, consumed_at, consumed_by_attempt_id, revoked_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auth.authorizationId, auth.releaseId, auth.artifactId, auth.artifactDigest,
      auth.commitSha, auth.environment, auth.securityDecisionId, auth.approvalId,
      auth.executionId, auth.projectId, auth.imageRepository, auth.imageTag,
      auth.imageId, auth.containerName, auth.containerPort, auth.issuedAt,
      auth.expiresAt, auth.consumedAt, auth.consumedByAttemptId, auth.revokedAt,
      now, now,
    );
  }

  getProductionAuthorization(authorizationId: string): StoredProductionAuthorization | undefined {
    this.ensureAuthorizationTable();
    const row = this.db.prepare(
      "SELECT * FROM production_execution_authorizations WHERE authorization_id = ?"
    ).get(authorizationId);
    return row ? this.mapProductionAuthorization(row) : undefined;
  }

  consumeProductionAuthorization(
    authorizationId: string,
    attemptId: string,
    now: Date = new Date(),
  ): { consumed: boolean; consumedAt: string | null; consumedByAttemptId: string | null } {
    this.ensureAuthorizationTable();
    const iso = now.toISOString();
    const info = this.db.prepare(`
      UPDATE production_execution_authorizations SET
        consumed_at = COALESCE(consumed_at, ?),
        consumed_by_attempt_id = COALESCE(consumed_by_attempt_id, ?),
        updated_at = ?
      WHERE authorization_id = ?
        AND (consumed_at IS NULL OR consumed_by_attempt_id = ?)
    `).run(iso, attemptId, Date.now(), authorizationId, attemptId);
    const fresh = this.getProductionAuthorization(authorizationId);
    return {
      consumed: (info.changes ?? 0) > 0,
      consumedAt: fresh?.consumedAt ?? null,
      consumedByAttemptId: fresh?.consumedByAttemptId ?? null,
    };
  }

  revokeProductionAuthorization(authorizationId: string, now: Date = new Date()): boolean {
    this.ensureAuthorizationTable();
    const info = this.db.prepare(`
      UPDATE production_execution_authorizations SET
        revoked_at = COALESCE(revoked_at, ?),
        updated_at = ?
      WHERE authorization_id = ?
    `).run(now.toISOString(), Date.now(), authorizationId);
    return (info.changes ?? 0) > 0;
  }

  private mapProductionAuthorization(row: any): StoredProductionAuthorization {
    return {
      authorizationId: row.authorization_id,
      releaseId: row.release_id,
      artifactId: row.artifact_id,
      artifactDigest: row.artifact_digest,
      commitSha: row.commit_sha,
      environment: row.environment,
      securityDecisionId: row.security_decision_id,
      approvalId: row.approval_id,
      executionId: row.execution_id ?? null,
      projectId: row.project_id ?? null,
      imageRepository: row.image_repository ?? null,
      imageTag: row.image_tag ?? null,
      imageId: row.image_id ?? null,
      containerName: row.container_name ?? null,
      containerPort: row.container_port ?? null,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? null,
      consumedByAttemptId: row.consumed_by_attempt_id ?? null,
      revokedAt: row.revoked_at ?? null,
    };
  }
  requestIntentCancellation(intentKey: string, now: number = Date.now()): boolean {
    this.ensureIntentTable();
    const info = this.db.prepare(`
      UPDATE release_deployment_intents SET
        cancel_requested_at = ?,
        updated_at = ?
      WHERE intent_key = ?
        AND cancel_requested_at IS NULL
        AND status NOT IN ('KNOWN_GOOD', 'FAILED', 'BLOCKED', 'CANCELLED')
    `).run(now, now, intentKey);
    return (info.changes ?? 0) > 0;
  }

  acknowledgeIntentCancellation(intentKey: string, now: number = Date.now()): boolean {
    this.ensureIntentTable();
    const info = this.db.prepare(`
      UPDATE release_deployment_intents SET
        cancel_acknowledged_at = ?,
        updated_at = ?
      WHERE intent_key = ?
        AND cancel_requested_at IS NOT NULL
        AND cancel_acknowledged_at IS NULL
    `).run(now, now, intentKey);
    return (info.changes ?? 0) > 0;
  }
  private mapReleaseIntent(row: any): ReleaseDeploymentIntent {
    return {
      intentKey: row.intent_key,
      releaseId: row.release_id,
      executionId: row.execution_id,
      attemptId: row.attempt_id ?? null,
      artifactId: row.artifact_id,
      artifactDigest: row.artifact_digest,
      commitSha: row.commit_sha,
      environment: row.environment,
      projectId: row.project_id ?? null,
      imageRepository: row.image_repository,
      imageTag: row.image_tag,
      imageId: row.image_id ?? null,
      imageDigest: row.image_digest,
      containerName: row.container_name,
      containerPort: row.container_port,
        intentKind: ((row.intent_kind ?? "DEPLOY") as "DEPLOY" | "ROLLBACK"),
        rollbackTargetReleaseId: row.rollback_target_release_id ?? null,
        rollbackJobId: row.rollback_job_id ?? null,
      status: row.status,
      deploymentId: row.deployment_id ?? null,
      failureReason: row.failure_reason ?? null,
      recoveryReason: row.recovery_reason ?? null,
      provider: row.provider ?? null,
      providerStatus: row.provider_status ?? null,
      providerDeploymentId: row.provider_deployment_id ?? null,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      reconciledAt: row.reconciled_at ?? null,
      cancelRequestedAt: row.cancel_requested_at ?? null,
      cancelAcknowledgedAt: row.cancel_acknowledged_at ?? null,
      leasedBy: row.leased_by ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      recoveryAttempts: row.recovery_attempts ?? 0,
      nextRetryAt: row.next_retry_at ?? null,
      lastFailureClass: row.last_failure_class ?? null,
      reconciliationEvidence: row.reconciliation_evidence ?? null,
      lastRecoveryDecision: row.last_recovery_decision ?? null,
      lastRecoveryDecisionAt: row.last_recovery_decision_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private mapLease(row: any): ExecutionLease {
    return {
      leaseId: row.lease_id,
      jobId: row.job_id,
      workerId: row.worker_id,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      renewedAt: row.renewed_at,
      releasedAt: row.released_at,
      status: row.status,
    };
  }

  private mapArtifact(row: any): ArtifactRecord {
    return {
      artifactId: row.artifact_id,
      jobId: row.job_id,
      releaseId: row.release_id,
      attemptId: row.attempt_id ?? undefined,
      name: row.name,
      type: row.type,
      sizeBytes: row.size_bytes,
      checksum: row.checksum,
      storageRef: row.storage_ref,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
    };
  }

  private mapRelease(row: any): ReleaseRecord {
    return {
      releaseId: row.release_id,
      version: row.version,
      buildInfo: row.build_info ? JSON.parse(row.build_info) : undefined,
      artifactId: row.artifact_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDeployment(row: any): DeploymentRecord {
    return {
      deploymentId: row.deployment_id,
      releaseId: row.release_id,
      environment: row.environment,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rollbackDeploymentId: row.rollback_deployment_id,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
    };
  }

  private mapApproval(row: any): ApprovalRequest {
    return {
      approvalId: row.approval_id,
      deploymentId: row.deployment_id,
      releaseId: row.release_id,
      environment: row.environment,
      requestedAction: row.requested_action,
      decision: row.decision,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

    // ---------- Remote Dispatches ----------
    /**
   * Phase 136: worker-authoritative remote result + dispatch persist. The
   * lease fence is evaluated before delegating to the existing transactional
   * persist path. In a single-connection better-sqlite3 process no await can
   * interleave between the check and the write, so this is atomic in practice.
   * A stale worker receives WORKER_OWNERSHIP_LOST and neither the result row
   * nor the dispatch update is committed.
   */
  persistRemoteExecutionResultAndDispatchAsOwner(
    result: RemoteExecutionResult,
    dispatch: RemoteDispatchRecord,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): { persisted: boolean; reason?: "WORKER_OWNERSHIP_LOST" } {
    const owned = this.db.prepare(`
      SELECT 1 FROM execution_leases
      WHERE lease_id = ? AND worker_id = ? AND job_id = ?
        AND status = 'ACTIVE' AND expires_at > ?
    `).get(leaseId, workerId, result.jobId, now);
    if (!owned) {
      return { persisted: false, reason: "WORKER_OWNERSHIP_LOST" };
    }
    this.persistRemoteExecutionResultAndDispatch(result, dispatch);
    return { persisted: true };
  }

  addRemoteDispatch(record: RemoteDispatchRecord): void {
        this.db.prepare(`
            INSERT INTO remote_dispatches (
                dispatch_id, job_id, attempt_id, worker_id, lease_id,
                idempotency_key, status, external_provider_id, request,
                result, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.dispatchId,
            record.jobId,
            record.attemptId,
            record.workerId,
            record.leaseId,
            record.idempotencyKey,
            record.status,
            record.externalProviderId,
            record.request ? JSON.stringify(record.request) : null,
            record.result ? JSON.stringify(record.result) : null,
            record.error,
            record.createdAt,
            record.updatedAt
        );
    }

    updateRemoteDispatch(record: RemoteDispatchRecord): void {
        this.db.prepare(`
            UPDATE remote_dispatches SET
                status = ?, external_provider_id = ?, result = ?, error = ?, updated_at = ?
            WHERE dispatch_id = ?
        `).run(
            record.status,
            record.externalProviderId,
            record.result ? JSON.stringify(record.result) : null,
            record.error,
            record.updatedAt,
            record.dispatchId
        );
    }

    createRemoteDispatchIfAbsent(record: RemoteDispatchRecord): { record: RemoteDispatchRecord; created: boolean } {
        try {
            this.addRemoteDispatch(record);
            return { record, created: true };
        } catch (err: any) {
            if (
                err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
                /UNIQUE constraint failed/i.test(err?.message ?? "")
            ) {
                const existing = this.getRemoteDispatchByJobIdempotencyKey(record.idempotencyKey);

                if (existing) {
                    return { record: existing, created: false };
                }
            }

            throw err;
        }
    }

    createRemoteDispatchIdempotent(record: RemoteDispatchRecord): { record: RemoteDispatchRecord; created: boolean } {
        // SELECT-first, INSERT-with-race-catch. Tolerant of missing UNIQUE index,
        // also correct when a UNIQUE index on idempotency_key exists.
        const existing = this.getRemoteDispatchByJobIdempotencyKey(record.idempotencyKey);
        if (existing) return { record: existing, created: false };
        try {
            this.addRemoteDispatch(record);
            return { record, created: true };
        } catch (err: any) {
            if (
                err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
                /UNIQUE constraint failed/i.test(err?.message ?? "")
            ) {
                const race = this.getRemoteDispatchByJobIdempotencyKey(record.idempotencyKey);
                if (race) return { record: race, created: false };
            }
            throw err;
        }
    }

    claimNextDispatchForWorker(workerId: string): RemoteDispatchRecord | undefined {
        // Atomic DB-level claim. A single conditional UPDATE is the correctness guarantee:
        // two concurrent pollers cannot both transition the same row DISPATCHED -> DELIVERED.
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
            const row: any = this.db
                .prepare(
                    "SELECT dispatch_id FROM remote_dispatches WHERE worker_id = ? AND status = 'DISPATCHED' ORDER BY created_at LIMIT 1"
                )
                .get(workerId);
            if (!row) return undefined;
            const info = this.db
                .prepare(
                    "UPDATE remote_dispatches SET status = 'DELIVERED', updated_at = ? WHERE dispatch_id = ? AND status = 'DISPATCHED'"
                )
                .run(now, row.dispatch_id);
            if (info.changes === 1) {
                return this.getRemoteDispatch(row.dispatch_id);
            }
            // Someone else claimed that row; retry for the next candidate.
        }
        return undefined;
    }
    upsertRemoteDispatch(record: RemoteDispatchRecord): void {
        const existing = this.getRemoteDispatch(record.dispatchId);
        if (existing) {
            this.updateRemoteDispatch(record);
        } else {
            this.addRemoteDispatch(record);
        }
    }

    getRemoteDispatch(dispatchId: string): RemoteDispatchRecord | undefined {
        const row = this.db.prepare("SELECT * FROM remote_dispatches WHERE dispatch_id = ?").get(dispatchId);
        return row ? this.mapRemoteDispatch(row) : undefined;
    }

    listRemoteDispatchesByJob(jobId: string): RemoteDispatchRecord[] {
        const rows = this.db.prepare("SELECT * FROM remote_dispatches WHERE job_id = ?").all(jobId);
        return rows.map((row: any) => this.mapRemoteDispatch(row));
    }

    listAllRemoteDispatches(): RemoteDispatchRecord[] {
        const rows = this.db.prepare("SELECT * FROM remote_dispatches").all();
        return rows.map((row: any) => this.mapRemoteDispatch(row));
    }

    private mapRemoteDispatch(row: any): RemoteDispatchRecord {
        return {
            dispatchId: row.dispatch_id,
            jobId: row.job_id,
            attemptId: row.attempt_id,
            workerId: row.worker_id,
            leaseId: row.lease_id,
            idempotencyKey: row.idempotency_key,
            status: row.status,
            externalProviderId: row.external_provider_id,
            request: row.request ? JSON.parse(row.request) : undefined,
            result: row.result ? JSON.parse(row.result) : undefined,
            error: row.error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }


    getRemoteDispatchByJobIdempotencyKey(key: string): RemoteDispatchRecord | undefined {
        const row = this.db.prepare("SELECT * FROM remote_dispatches WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1").get(key);
        return row ? this.mapRemoteDispatch(row) : undefined;
    }

    // ---------- Remote Execution Results ----------
    addRemoteExecutionResult(result: RemoteExecutionResult): void {
        this.db.prepare(`
            INSERT INTO remote_execution_results (
                result_id, job_id, attempt_id, worker_id, dispatch_id,
                lease_id, success, exit_code, stdout_ref, stderr_ref,
                evidence, created_at, stdout_sha256, stderr_sha256,
                result_sha256, verification_status, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            result.resultId,
            result.jobId,
            result.attemptId,
            result.workerId,
            result.dispatchId,
            result.leaseId,
            result.success ? 1 : 0,
            result.exitCode,
            result.stdoutRef,
            result.stderrRef,
            result.evidence ? JSON.stringify(result.evidence) : null,
            result.createdAt,
            result.stdoutSha256,
            result.stderrSha256,
            result.resultSha256,
            result.verificationStatus ?? "PENDING",
            result.verifiedAt
        );
    }

    getRemoteExecutionResultByDispatchId(dispatchId: string): RemoteExecutionResult | undefined {
        const row = this.db.prepare("SELECT * FROM remote_execution_results WHERE dispatch_id = ?").get(dispatchId);
        return row ? this.mapRemoteExecutionResult(row) : undefined;
    }

    getRemoteExecutionResultByJobId(jobId: string): RemoteExecutionResult | undefined {
        const row = this.db.prepare("SELECT * FROM remote_execution_results WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId);
        return row ? this.mapRemoteExecutionResult(row) : undefined;
    }

    private mapRemoteExecutionResult(row: any): RemoteExecutionResult {
        return {
            resultId: row.result_id,
            jobId: row.job_id,
            attemptId: row.attempt_id,
            workerId: row.worker_id,
            dispatchId: row.dispatch_id,
            leaseId: row.lease_id,
            success: !!row.success,
            exitCode: row.exit_code,
            stdoutRef: row.stdout_ref,
            stderrRef: row.stderr_ref,
            evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
            createdAt: row.created_at,
            stdoutSha256: row.stdout_sha256,
            stderrSha256: row.stderr_sha256,
            resultSha256: row.result_sha256,
            verificationStatus: row.verification_status,
            verifiedAt: row.verified_at,
        };
    }
    listRemoteDispatchesByWorkerStatus(workerId: string, status: string): RemoteDispatchRecord[] {
        const rows = this.db.prepare(
            "SELECT * FROM remote_dispatches WHERE worker_id = ? AND status = ? ORDER BY created_at"
        ).all(workerId, status);
        return rows.map((row: any) => this.mapRemoteDispatch(row));
    }

    persistRemoteExecutionResultAndDispatch(
        result: RemoteExecutionResult,
        dispatch: RemoteDispatchRecord
    ): void {
        const run = () => {
            this.addRemoteExecutionResult(result);
            this.updateRemoteDispatch(dispatch);
        };
        // Two shapes are accepted at runtime:
        //  * raw better-sqlite3 Database (what the kernel passes) -
        //    db.transaction(fn) returns a callable wrapper that must be invoked.
        //  * SQLiteEngine - its transaction(fn) already executes fn eagerly and
        //    returns fn's result, so we must NOT call anything a second time.
        // Detecting the shape and invoking only the callable keeps both correct.
        const maybeTx: any = (this.db as any).transaction(run);
        if (typeof maybeTx === "function") {
            maybeTx();
        }
    }

  // ---------- Phase 187: durable attempt heartbeat ----------
  // Atomic ownership-fenced heartbeat. Refuses to touch anything unless:
  //   - the lease exists AND is ACTIVE AND is not expired
  //   - the lease is owned by workerId AND bound to jobId
  //   - the attempt exists, is RUNNING, and matches job/worker/lease
  // Renews the lease in the same transaction so liveness and fencing move
  // together. Returns an explicit refusal reason on failure -- never a silent
  // success.
  async attemptHeartbeatAsync(input: {
    attemptId: string;
    jobId: string;
    workerId: string;
    leaseId: string;
    ttlMs?: number;
    now?: number;
  }): Promise<{
    ok: boolean;
    reason?: "LEASE_NOT_FOUND" | "LEASE_EXPIRED" | "WORKER_OWNERSHIP_LOST"
           | "ATTEMPT_NOT_RUNNING" | "FENCED" | "JOB_STATE_INVALID";
    expiresAt?: number;
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const ttlMs = input.ttlMs ?? 60000;

    let result: {
      ok: boolean;
      reason?: "LEASE_NOT_FOUND" | "LEASE_EXPIRED" | "WORKER_OWNERSHIP_LOST"
             | "ATTEMPT_NOT_RUNNING" | "FENCED" | "JOB_STATE_INVALID";
      expiresAt?: number;
    } = { ok: false };

    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        // 1. Lock and verify the lease is currently valid for this owner.
        const lease = await tx.prepareAsync(
          "SELECT lease_id, worker_id, status, expires_at FROM execution_leases " +
          "WHERE lease_id = ? AND job_id = ? FOR UPDATE",
        ).get<{ lease_id: string; worker_id: string; status: string; expires_at: string | number }>(
          input.leaseId, input.jobId,
        );
        if (!lease) { result = { ok: false, reason: "LEASE_NOT_FOUND" }; throw new AbortTx(); }
        if (lease.status !== "ACTIVE") { result = { ok: false, reason: "FENCED" }; throw new AbortTx(); }
        if (Number(lease.expires_at) <= now) { result = { ok: false, reason: "LEASE_EXPIRED" }; throw new AbortTx(); }
        if (lease.worker_id !== input.workerId) { result = { ok: false, reason: "WORKER_OWNERSHIP_LOST" }; throw new AbortTx(); }

        // 2. Attempt must be RUNNING and bound to the same (job, worker, lease).
        const attempt = await tx.prepareAsync(
          "SELECT id, status, worker_id, lease_id FROM execution_attempts " +
          "WHERE id = ? AND job_id = ? FOR UPDATE",
        ).get<{ id: string; status: string; worker_id: string | null; lease_id: string | null }>(
          input.attemptId, input.jobId,
        );
        if (!attempt) { result = { ok: false, reason: "ATTEMPT_NOT_RUNNING" }; throw new AbortTx(); }
        if (attempt.status !== "RUNNING") { result = { ok: false, reason: "ATTEMPT_NOT_RUNNING" }; throw new AbortTx(); }
        if (attempt.worker_id !== input.workerId || attempt.lease_id !== input.leaseId) {
          result = { ok: false, reason: "WORKER_OWNERSHIP_LOST" };
          throw new AbortTx();
        }

        // 3. Job must still be in an active execution state.
        const job = await tx.prepareAsync(
          "SELECT status, cancellation_requested FROM execution_jobs WHERE id = ? FOR UPDATE",
        ).get<{ status: string; cancellation_requested: number }>(input.jobId);
        if (!job) { result = { ok: false, reason: "JOB_STATE_INVALID" }; throw new AbortTx(); }
        if (job.status !== "RUNNING" && job.status !== "VERIFYING" && job.status !== "CLAIMED") {
          result = { ok: false, reason: "JOB_STATE_INVALID" };
          throw new AbortTx();
        }

        const expiresAt = now + ttlMs;

        // 4. Renew lease.
        await tx.prepareAsync(
          "UPDATE execution_leases SET renewed_at = ?, expires_at = ? WHERE lease_id = ?",
        ).run(now, expiresAt, input.leaseId);

        // 5. Update attempt heartbeat.
        await tx.prepareAsync(
          "UPDATE execution_attempts SET heartbeat_at = ? WHERE id = ?",
        ).run(now, input.attemptId);

        result = { ok: true, expiresAt };
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }

    return result;
  }

  // ---------- Phase 187: list stale running attempts ----------
  // Returns RUNNING attempts whose heartbeat has aged past maxAgeMs. Uses the
  // partial index idx_attempts_stale_running. Ordered oldest-first so recovery
  // processes the most-stale attempts first.
  async listStaleAttemptsAsync(now: number, maxAgeMs: number): Promise<Array<{
    attemptId: string;
    jobId: string;
    workerId: string;
    leaseId: string;
    heartbeatAt: number;
  }>> {
    const engine = this.requireAsyncDb();
    const cutoff = now - maxAgeMs;
    const rows = await engine.prepareAsync(
      "SELECT id, job_id, worker_id, lease_id, heartbeat_at FROM execution_attempts " +
      "WHERE status = 'RUNNING' AND heartbeat_at IS NOT NULL AND heartbeat_at < ? " +
      "ORDER BY heartbeat_at ASC",
    ).all<any>(cutoff);
    return rows.map((r) => ({
      attemptId: r.id,
      jobId: r.job_id,
      workerId: r.worker_id,
      leaseId: r.lease_id,
      heartbeatAt: Number(r.heartbeat_at),
    }));
  }

  // ---------- Phase 187: fence a stale attempt ----------
  // Atomically transitions a stale RUNNING attempt to FAILED and expires its
  // lease. Only acts when the attempt is still RUNNING AND its heartbeat is
  // still older than the cutoff. Returns whether the fence actually applied
  // (so duplicate recovery calls converge to no-op) and a boolean indicating
  // whether the caller should proceed to retry scheduling.
  async fenceStaleAttemptAsync(input: {
    attemptId: string;
    jobId: string;
    leaseId: string;
    reason: string;
    now?: number;
    staleCutoffMs: number;
  }): Promise<{
    fenced: boolean;
    alreadyFenced?: boolean;
    reason?: "ATTEMPT_NOT_RUNNING" | "NOT_STALE" | "LEASE_MISMATCH";
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const cutoff = now - input.staleCutoffMs;

    let result: {
      fenced: boolean;
      alreadyFenced?: boolean;
      reason?: "ATTEMPT_NOT_RUNNING" | "NOT_STALE" | "LEASE_MISMATCH";
    } = { fenced: false };

    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        const attempt = await tx.prepareAsync(
          "SELECT status, heartbeat_at, lease_id FROM execution_attempts " +
          "WHERE id = ? AND job_id = ? FOR UPDATE",
        ).get<{ status: string; heartbeat_at: string | number | null; lease_id: string | null }>(
          input.attemptId, input.jobId,
        );
        if (!attempt) { result = { fenced: false, reason: "ATTEMPT_NOT_RUNNING" }; throw new AbortTx(); }
        if (attempt.status !== "RUNNING") { result = { fenced: false, alreadyFenced: true, reason: "ATTEMPT_NOT_RUNNING" }; throw new AbortTx(); }
        if (attempt.lease_id !== input.leaseId) { result = { fenced: false, reason: "LEASE_MISMATCH" }; throw new AbortTx(); }
        // Only fence if still stale -- protects against the heartbeat that
        // raced in between the caller's read and this transaction.
        const hb = attempt.heartbeat_at === null ? 0 : Number(attempt.heartbeat_at);
        if (hb >= cutoff) { result = { fenced: false, reason: "NOT_STALE" }; throw new AbortTx(); }

        // 1. Fail the attempt (durable history preserved).
        const a = await tx.prepareAsync(
          "UPDATE execution_attempts SET status = 'FAILED', completed_at = ?, error = ? " +
          "WHERE id = ? AND status = 'RUNNING'",
        ).run(now, input.reason, input.attemptId);
        if ((a.changes ?? 0) !== 1) { result = { fenced: false, alreadyFenced: true }; throw new AbortTx(); }

        // 2. Expire the lease so it is no longer ACTIVE.
        await tx.prepareAsync(
          "UPDATE execution_leases SET status = 'EXPIRED', released_at = ? " +
          "WHERE lease_id = ? AND status = 'ACTIVE'",
        ).run(now, input.leaseId);

        // 3. Transition job RUNNING/CLAIMED/VERIFYING -> ORPHANED and clear
        //    current_lease_id. -- Phase 187 B3: transition job to ORPHANED
        //    so the existing Phase 184 recovery flow (recoverStaleJobs) can
        //    apply retry policy and move it to QUEUED / RETRY_SCHEDULED.
        await tx.prepareAsync(
          "UPDATE execution_jobs SET status = 'ORPHANED', current_lease_id = NULL, updated_at = ? " +
          "WHERE id = ? " +
          "  AND status IN ('RUNNING','CLAIMED','VERIFYING','CANCELLATION_REQUESTED')",
        ).run(now, input.jobId);

        // 4. Event.
        const eventId = "evt_fence_" + input.attemptId + "_" + now + "_" + Math.random().toString(36).slice(2, 8);
        await tx.prepareAsync(
          "INSERT INTO execution_events (event_id, job_id, event_type, payload, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ).run(
          eventId, input.jobId, "scheduler.attempt.fenced",
          JSON.stringify({
            attemptId: input.attemptId,
            leaseId: input.leaseId,
            reason: input.reason,
            fencedAt: now,
            previousHeartbeatAt: hb,
          }),
          now,
        );

        result = { fenced: true };
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }

    return result;
  }


  // ---------- Phase 189: durable result retrieval ----------
  // Read-only queries that reassemble a completed attempt's durable state
  // from PostgreSQL without relying on any in-memory worker state.

  /** All artifacts bound to an attempt, newest first. */
  async listAttemptArtifactsAsync(attemptId: string): Promise<ArtifactRecord[]> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT * FROM execution_artifacts WHERE attempt_id = ? ORDER BY created_at DESC",
    ).all<any>(attemptId);
    return rows.map((r) => this.mapArtifact(r));
  }

  /** All durable events for a job, oldest first. */
  async listEventsForJobAsync(jobId: string): Promise<Array<{ eventId: string; eventType: string; payload: unknown; createdAt: number }>> {
    const engine = this.requireAsyncDb();
    const rows = await engine.prepareAsync(
      "SELECT event_id, event_type, payload, created_at FROM execution_events WHERE job_id = ? ORDER BY created_at ASC",
    ).all<any>(jobId);
    return rows.map((r) => ({
      eventId: r.event_id,
      eventType: r.event_type,
      payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null,
      createdAt: Number(r.created_at),
    }));
  }

  /** Full durable result for an attempt: attempt row + job + provenance + artifacts. */
  async getAttemptResultAsync(attemptId: string): Promise<{
    attempt: ExecutionAttempt;
    job: ExecutionJob;
    provenance: {
      provenanceId: string;
      outcome: string;
      evidenceJson: string | null;
      evidenceHash: string;
      terminalizedAt: number;
    } | null;
    artifacts: ArtifactRecord[];
  } | null> {
    const engine = this.requireAsyncDb();
    const aRow = await engine.prepareAsync(
      "SELECT * FROM execution_attempts WHERE id = ?",
    ).get<any>(attemptId);
    if (!aRow) return null;
    const attempt = this.mapAttempt(aRow);
    const jRow = await engine.prepareAsync(
      "SELECT * FROM execution_jobs WHERE id = ?",
    ).get<any>(attempt.jobId);
    if (!jRow) return null;
    const job = this.mapJob(jRow);

    const pRow = await engine.prepareAsync(
      "SELECT provenance_id, outcome, evidence_json, evidence_hash, terminalized_at " +
      "FROM execution_outcome_provenance WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get<any>(attemptId);
    const provenance = pRow ? {
      provenanceId: pRow.provenance_id,
      outcome: pRow.outcome,
      evidenceJson: pRow.evidence_json ?? null,
      evidenceHash: pRow.evidence_hash,
      terminalizedAt: Number(pRow.terminalized_at),
    } : null;

    const artRows = await engine.prepareAsync(
      "SELECT * FROM execution_artifacts WHERE attempt_id = ? ORDER BY created_at ASC",
    ).all<any>(attemptId);
    const artifacts = artRows.map((r) => this.mapArtifact(r));

    return { attempt, job, provenance, artifacts };
  }

  /**
   * Full durable result for a job: latest attempt + its provenance + artifacts
   * + chronological events. Returns null if the job doesn't exist.
   */
  async getExecutionResultAsync(jobId: string): Promise<{
    job: ExecutionJob;
    attempt: ExecutionAttempt | null;
    provenance: {
      provenanceId: string;
      outcome: string;
      evidenceJson: string | null;
      evidenceHash: string;
      terminalizedAt: number;
    } | null;
    artifacts: ArtifactRecord[];
    events: Array<{ eventId: string; eventType: string; payload: unknown; createdAt: number }>;
  } | null> {
    const engine = this.requireAsyncDb();
    const jRow = await engine.prepareAsync(
      "SELECT * FROM execution_jobs WHERE id = ?",
    ).get<any>(jobId);
    if (!jRow) return null;
    const job = this.mapJob(jRow);

    const aRow = await engine.prepareAsync(
      "SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1",
    ).get<any>(jobId);
    const attempt = aRow ? this.mapAttempt(aRow) : null;

    let provenance: any = null;
    let artifacts: ArtifactRecord[] = [];
    if (attempt) {
      const pRow = await engine.prepareAsync(
        "SELECT provenance_id, outcome, evidence_json, evidence_hash, terminalized_at " +
        "FROM execution_outcome_provenance WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get<any>(attempt.id);
      if (pRow) provenance = {
        provenanceId: pRow.provenance_id,
        outcome: pRow.outcome,
        evidenceJson: pRow.evidence_json ?? null,
        evidenceHash: pRow.evidence_hash,
        terminalizedAt: Number(pRow.terminalized_at),
      };
      const artRows = await engine.prepareAsync(
        "SELECT * FROM execution_artifacts WHERE attempt_id = ? ORDER BY created_at ASC",
      ).all<any>(attempt.id);
      artifacts = artRows.map((r) => this.mapArtifact(r));
    }

    const evRows = await engine.prepareAsync(
      "SELECT event_id, event_type, payload, created_at FROM execution_events WHERE job_id = ? ORDER BY created_at ASC",
    ).all<any>(jobId);
    const events = evRows.map((r) => ({
      eventId: r.event_id,
      eventType: r.event_type,
      payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null,
      createdAt: Number(r.created_at),
    }));

    return { job, attempt, provenance, artifacts, events };
  }


  // ---------- Phase 189: artifact integrity verification ----------
  //
  // Honest verification state. Because no byte-storage adapter exists in
  // the current codebase, we cannot read artifact bytes back for a real
  // checksum comparison. Instead of faking VERIFIED, we:
  //   1. Locate the artifact row durably.
  //   2. Validate what we CAN check locally (checksum present, size present).
  //   3. Record one of: PENDING, VERIFIED, MISMATCH, UNAVAILABLE, ERROR.
  //
  // If the caller supplies an `actualChecksum` (e.g. from a real storage
  // adapter once one exists), we perform the real comparison and record
  // VERIFIED or MISMATCH. If not, we record UNAVAILABLE and explain why.
  // The method never claims VERIFIED unless a real comparison was made.
  async verifyArtifactAsync(input: {
    artifactId: string;
    expectedAttemptId?: string;
    expectedJobId?: string;
    actualChecksum?: string;
    actualSizeBytes?: number;
    verifier?: string;
    now?: number;
  }): Promise<{
    ok: boolean;
    status: "VERIFIED" | "MISMATCH" | "UNAVAILABLE" | "ERROR";
    reason?: "ARTIFACT_NOT_FOUND" | "CROSS_ATTEMPT_REJECTED" | "CROSS_JOB_REJECTED" | "NO_STORAGE_ADAPTER";
    expectedChecksum?: string;
    actualChecksum?: string;
    expectedSizeBytes?: number;
    actualSizeBytes?: number;
    verifiedAt?: number;
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();

    let result: any = { ok: false, status: "ERROR" };
    class AbortTx extends Error {}

    try {
      await engine.transactionAsync(async (tx) => {
        const row = await tx.prepareAsync(
          "SELECT * FROM execution_artifacts WHERE artifact_id = ? FOR UPDATE",
        ).get<any>(input.artifactId);
        if (!row) { result = { ok: false, status: "ERROR", reason: "ARTIFACT_NOT_FOUND" }; throw new AbortTx(); }

        // Cross-attempt / cross-job safety: if the caller pins the expected
        // attempt or job, reject any mismatch before touching the row.
        if (input.expectedAttemptId && row.attempt_id && row.attempt_id !== input.expectedAttemptId) {
          result = { ok: false, status: "ERROR", reason: "CROSS_ATTEMPT_REJECTED" };
          throw new AbortTx();
        }
        if (input.expectedJobId && row.job_id && row.job_id !== input.expectedJobId) {
          result = { ok: false, status: "ERROR", reason: "CROSS_JOB_REJECTED" };
          throw new AbortTx();
        }

        const expectedChecksum = row.checksum as string;
        const expectedSizeBytes = row.size_bytes === null ? undefined : Number(row.size_bytes);

        // If the caller did not supply actual bytes/checksum, we cannot
        // perform real verification. Record UNAVAILABLE -- not VERIFIED.
        if (!input.actualChecksum) {
          await tx.prepareAsync(
            "UPDATE execution_artifacts SET integrity_status = 'UNAVAILABLE', integrity_verified_at = ? WHERE artifact_id = ?",
          ).run(now, input.artifactId);
          await this.addEventOnEngine(tx, {
            eventId: `evt_verify_${input.artifactId}_${now}_${Math.random().toString(36).slice(2,8)}`,
            jobId: row.job_id,
            eventType: "execution.artifact.verify_unavailable",
            payload: {
              artifactId: input.artifactId,
              attemptId: row.attempt_id,
              verifier: input.verifier ?? null,
              reason: "NO_STORAGE_ADAPTER",
              expectedChecksum,
            },
            createdAt: now,
          } as ExecutionEvent);
          result = {
            ok: true, status: "UNAVAILABLE", reason: "NO_STORAGE_ADAPTER",
            expectedChecksum, expectedSizeBytes, verifiedAt: now,
          };
          // Phase 189: commit the UNAVAILABLE status. Throw only for
          // real errors (missing artifact, cross-attempt rejection).
          return;
        }

        // Real comparison path.
        const match = input.actualChecksum === expectedChecksum;
        const sizeMatch = input.actualSizeBytes === undefined || input.actualSizeBytes === expectedSizeBytes;
        const status = (match && sizeMatch) ? "VERIFIED" : "MISMATCH";

        await tx.prepareAsync(
          "UPDATE execution_artifacts SET integrity_status = ?, integrity_verified_at = ? WHERE artifact_id = ?",
        ).run(status, now, input.artifactId);

        await this.addEventOnEngine(tx, {
          eventId: `evt_verify_${input.artifactId}_${now}_${Math.random().toString(36).slice(2,8)}`,
          jobId: row.job_id,
          eventType: status === "VERIFIED" ? "execution.artifact.verified" : "execution.artifact.mismatch",
          payload: {
            artifactId: input.artifactId,
            attemptId: row.attempt_id,
            verifier: input.verifier ?? null,
            expectedChecksum,
            actualChecksum: input.actualChecksum,
            expectedSizeBytes,
            actualSizeBytes: input.actualSizeBytes ?? null,
          },
          createdAt: now,
        } as ExecutionEvent);

        result = {
          ok: status === "VERIFIED", status,
          expectedChecksum, actualChecksum: input.actualChecksum,
          expectedSizeBytes, actualSizeBytes: input.actualSizeBytes,
          verifiedAt: now,
        };
        return;
      });
    } catch (e) {
      if (!(e instanceof AbortTx)) throw e;
    }
    return result;
  }

  /**
   * Read back the durable verification state of an artifact.
   * Never claims VERIFIED unless the row's integrity_status literally says so.
   */
  async getArtifactIntegrityAsync(artifactId: string): Promise<{
    status: string;
    verifiedAt: number | null;
    expectedChecksum: string | null;
  } | null> {
    const engine = this.requireAsyncDb();
    const row = await engine.prepareAsync(
      "SELECT integrity_status, integrity_verified_at, checksum FROM execution_artifacts WHERE artifact_id = ?",
    ).get<any>(artifactId);
    if (!row) return null;
    return {
      status: row.integrity_status ?? "PENDING",
      verifiedAt: row.integrity_verified_at === null ? null : Number(row.integrity_verified_at),
      expectedChecksum: row.checksum ?? null,
    };
  }

  /**
   * Phase 189: reconcile a completed execution. Detects structural
   * inconsistencies and records durable findings via events. Never mutates
   * artifact / attempt / job rows speculatively.
   *
   * Idempotent: repeated runs produce the same set of `finding:<kind>`
   * events per job, keyed deterministically on jobId+attemptId.
   */
  async reconcileCompletedExecutionAsync(input: {
    jobId: string;
    now?: number;
  }): Promise<{
    ok: boolean;
    findings: string[];
    artifactsChecked: number;
    orphanArtifacts: number;
    missingArtifacts: number;
    activeLeaseOnTerminal: number;
  }> {
    const engine = this.requireAsyncDb();
    const now = input.now ?? Date.now();
    const findings: string[] = [];
    let orphanArtifacts = 0;
    let missingArtifacts = 0;
    let activeLeaseOnTerminal = 0;
    let artifactsChecked = 0;

    await engine.transactionAsync(async (tx) => {
      const job = await tx.prepareAsync(
        "SELECT * FROM execution_jobs WHERE id = ?",
      ).get<any>(input.jobId);
      if (!job) { findings.push("JOB_NOT_FOUND"); return; }

      // Terminal-jobs-with-active-lease check.
      const TERMINAL = ["SUCCEEDED","FAILED","CANCELLED","DEAD_LETTER"];
      if (TERMINAL.includes(job.status)) {
        const active = await tx.prepareAsync(
          "SELECT lease_id FROM execution_leases WHERE job_id = ? AND status = 'ACTIVE'",
        ).all<{ lease_id: string }>(input.jobId);
        if (active.length > 0) {
          activeLeaseOnTerminal = active.length;
          findings.push("TERMINAL_JOB_HAS_ACTIVE_LEASE");
        }
      }

      // All artifacts whose job_id points at this job.
      const arts = await tx.prepareAsync(
        "SELECT artifact_id, job_id, attempt_id, checksum, integrity_status FROM execution_artifacts WHERE job_id = ?",
      ).all<any>(input.jobId);
      for (const a of arts) {
        artifactsChecked++;
        if (!a.attempt_id) { orphanArtifacts++; findings.push("ARTIFACT_WITHOUT_ATTEMPT:" + a.artifact_id); continue; }
        const att = await tx.prepareAsync(
          "SELECT id FROM execution_attempts WHERE id = ?",
        ).get<any>(a.attempt_id);
        if (!att) {
          orphanArtifacts++;
          findings.push("ORPHAN_ARTIFACT:" + a.artifact_id);
          continue;
        }
        if (a.integrity_status === "UNAVAILABLE" || a.integrity_status === null || a.integrity_status === "PENDING") {
          findings.push("ARTIFACT_UNVERIFIED:" + a.artifact_id);
        }
        if (a.integrity_status === "MISMATCH") {
          findings.push("ARTIFACT_MISMATCH:" + a.artifact_id);
        }
      }

      // Attempts reference artifacts: check each attempt has at least one artifact row
      // IF the provenance or evidence declares artifacts. We can't infer that from
      // the current schema, so this check is a no-op unless provenance.evidence_json
      // includes an `artifacts` array (optional convention).
      const provs = await tx.prepareAsync(
        "SELECT attempt_id, evidence_json FROM execution_outcome_provenance WHERE job_id = ?",
      ).all<any>(input.jobId);
      for (const p of provs) {
        if (!p.evidence_json) continue;
        let parsed: any = null;
        try { parsed = JSON.parse(p.evidence_json); } catch { continue; }
        if (!parsed || !Array.isArray(parsed)) continue;
        for (const artId of parsed) {
          const exists = await tx.prepareAsync(
            "SELECT 1 FROM execution_artifacts WHERE artifact_id = ?",
          ).get<any>(String(artId));
          if (!exists) {
            missingArtifacts++;
            findings.push("MISSING_ARTIFACT:" + String(artId));
          }
        }
      }

      // Emit one summary event (deterministic eventId so repeats converge).
      const eventId = "evt_reconcile_" + input.jobId + "_" + findings.slice().sort().join("|").slice(0, 200).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
      const existing = await tx.prepareAsync(
        "SELECT event_id FROM execution_events WHERE event_id = ?",
      ).get<any>(eventId);
      if (!existing) {
        await this.addEventOnEngine(tx, {
          eventId,
          jobId: input.jobId,
          eventType: findings.length === 0 ? "execution.reconcile.clean" : "execution.reconcile.findings",
          payload: {
            jobId: input.jobId,
            jobStatus: job.status,
            findingCount: findings.length,
            findings: findings.slice(0, 50),
            artifactsChecked,
            orphanArtifacts,
            missingArtifacts,
            activeLeaseOnTerminal,
          },
          createdAt: now,
        } as ExecutionEvent);
      }
    });

    return { ok: findings.length === 0, findings, artifactsChecked, orphanArtifacts, missingArtifacts, activeLeaseOnTerminal };
  }


  // ---------- Phase 190: release/deployment chain provenance ----------
  //
  // Reassembles execution -> attempt -> artifact -> release intent -> deployment
  // from durable PostgreSQL state. Every node is read fresh; nothing is
  // inferred from in-memory state. The result exposes both the raw nodes
  // and a classifier so callers can act on the shape without re-deriving it.
  async getReleaseDeploymentChainAsync(input: {
    intentKey: string;
  }): Promise<{
    found: boolean;
    intent: ReleaseDeploymentIntent | null;
    execution: {
      job: ExecutionJob | null;
      attempt: ExecutionAttempt | null;
      provenance: {
        provenanceId: string;
        outcome: string;
        evidenceJson: string | null;
        evidenceHash: string;
        terminalizedAt: number;
      } | null;
    };
    artifact: {
      artifactId: string;
      attemptId: string | null;
      jobId: string | null;
      releaseId: string | null;
      checksum: string;
      sizeBytes: number | null;
      storageRef: string | null;
      integrityStatus: string;
      integrityVerifiedAt: number | null;
      boundToIntent: boolean;
    } | null;
    events: Array<{ eventId: string; eventType: string; payload: unknown; createdAt: number }>;
    chainComplete: boolean;
    chainStatus: "INTENT_NOT_FOUND" | "EXECUTION_INCOMPLETE" | "EXECUTION_COMPLETE_NO_PROVENANCE" | "ARTIFACT_MISSING" | "ARTIFACT_UNBOUND" | "ARTIFACT_UNVERIFIED" | "CHAIN_COMPLETE" | "CHAIN_INCOMPLETE";
  }> {
    const engine = this.requireAsyncDb();
    const empty = {
      found: false,
      intent: null,
      execution: { job: null, attempt: null, provenance: null },
      artifact: null,
      events: [],
      chainComplete: false,
      chainStatus: "INTENT_NOT_FOUND" as const,
    };

    const intent = await this.getReleaseIntentAsync(input.intentKey);
    if (!intent) return empty;

    // Execution job (intent.executionId is the job id in current NEXUS
    // convention; if a future schema changes this we surface null).
    const jobRow = await engine.prepareAsync(
      "SELECT * FROM execution_jobs WHERE id = ?",
    ).get<any>(intent.executionId);
    const job = jobRow ? this.mapJob(jobRow) : null;

    // Attempt: prefer explicit intent.attemptId, else latest attempt for the job.
    let attempt: ExecutionAttempt | null = null;
    if (intent.attemptId) {
      const aRow = await engine.prepareAsync(
        "SELECT * FROM execution_attempts WHERE id = ?",
      ).get<any>(intent.attemptId);
      if (aRow) attempt = this.mapAttempt(aRow);
    }
    if (!attempt && job) {
      const aRow = await engine.prepareAsync(
        "SELECT * FROM execution_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1",
      ).get<any>(job.id);
      if (aRow) attempt = this.mapAttempt(aRow);
    }

    // Provenance for the resolved attempt.
    let provenance: any = null;
    if (attempt) {
      const pRow = await engine.prepareAsync(
        "SELECT provenance_id, outcome, evidence_json, evidence_hash, terminalized_at " +
        "FROM execution_outcome_provenance WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get<any>(attempt.id);
      if (pRow) provenance = {
        provenanceId: pRow.provenance_id,
        outcome: pRow.outcome,
        evidenceJson: pRow.evidence_json ?? null,
        evidenceHash: pRow.evidence_hash,
        terminalizedAt: Number(pRow.terminalized_at),
      };
    }

    // Artifact via intent.artifactId — strictly bound or reported unbound.
    let artifact: any = null;
    let artifactBound = false;
    const artRow = await engine.prepareAsync(
      "SELECT * FROM execution_artifacts WHERE artifact_id = ?",
    ).get<any>(intent.artifactId);
    if (artRow) {
      const artAttemptId = artRow.attempt_id ?? null;
      const artJobId = artRow.job_id ?? null;
      // Strict binding: attemptId must match if intent declares it, and
      // jobId must match intent.executionId when both are non-null.
      artifactBound = true;
      if (intent.attemptId && artAttemptId !== intent.attemptId) artifactBound = false;
      if (artJobId && intent.executionId && artJobId !== intent.executionId) artifactBound = false;
      artifact = {
        artifactId: artRow.artifact_id,
        attemptId: artAttemptId,
        jobId: artJobId,
        releaseId: artRow.release_id ?? null,
        checksum: artRow.checksum,
        sizeBytes: artRow.size_bytes === null ? null : Number(artRow.size_bytes),
        storageRef: artRow.storage_ref ?? null,
        integrityStatus: artRow.integrity_status ?? "PENDING",
        integrityVerifiedAt: artRow.integrity_verified_at === null ? null : Number(artRow.integrity_verified_at),
        boundToIntent: artifactBound,
      };
    }

    // Events scoped to the execution id (job).
    const evRows = await engine.prepareAsync(
      "SELECT event_id, event_type, payload, created_at FROM execution_events WHERE job_id = ? ORDER BY created_at ASC",
    ).all<any>(intent.executionId);
    const events = evRows.map((r) => ({
      eventId: r.event_id,
      eventType: r.event_type,
      payload: r.payload ? (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })() : null,
      createdAt: Number(r.created_at),
    }));

    // Classify.
    let chainStatus: any = "CHAIN_INCOMPLETE";
    let chainComplete = false;
    if (!job) {
      chainStatus = "EXECUTION_INCOMPLETE";
    } else if (!attempt || (attempt.status !== "SUCCEEDED" && attempt.status !== "FAILED" && attempt.status !== "CANCELLED" && attempt.status !== "DEAD_LETTER")) {
      chainStatus = "EXECUTION_INCOMPLETE";
    } else if (!provenance) {
      chainStatus = "EXECUTION_COMPLETE_NO_PROVENANCE";
    } else if (!artifact) {
      chainStatus = "ARTIFACT_MISSING";
    } else if (!artifact.boundToIntent) {
      chainStatus = "ARTIFACT_UNBOUND";
    } else if (artifact.integrityStatus === "VERIFIED") {
      chainComplete = true;
      chainStatus = "CHAIN_COMPLETE";
    } else if (artifact.integrityStatus === "PENDING" || artifact.integrityStatus === "UNAVAILABLE") {
      chainStatus = "ARTIFACT_UNVERIFIED";
    } else {
      chainStatus = "CHAIN_INCOMPLETE";
    }

    return {
      found: true,
      intent,
      execution: { job, attempt, provenance },
      artifact,
      events,
      chainComplete,
      chainStatus,
    };
  }

  // ---------- Phase 190: chain status classifier ----------
  //
  // Light-weight version of getReleaseDeploymentChainAsync. Returns just the
  // classifier + a boolean, without assembling the full node set. Intended
  // for reconciliation sweeps over many intents.
  async getReleaseIntentChainStatusAsync(intentKey: string): Promise<{
    found: boolean;
    chainStatus: string;
    chainComplete: boolean;
  }> {
    const chain = await this.getReleaseDeploymentChainAsync({ intentKey });
    return { found: chain.found, chainStatus: chain.chainStatus, chainComplete: chain.chainComplete };
  }
}

// Phase 167: service-boundary read surface for audit/provenance.
export type ExecutionAuditStore = Pick<ExecutionStore,
  | "queryProvenanceById"
  | "queryProvenanceByAttempt"
  | "queryProvenanceByRecoveryOperation"
  | "queryRetryLineage"
  | "pageProvenanceByJob"
  | "verifyProvenanceByAttempt"
  | "verifyProvenanceById"
  | "getJob"
>;
