import { NexusEngine } from "./db";
import { RemoteDispatchRecord, RemoteExecutionResult } from "./execution-models";
import {
  ExecutionJob,
  ExecutionAttempt,
  ExecutionWorker,
  ExecutionLease,
  ArtifactRecord,
  ReleaseRecord,
  DeploymentRecord,
  ApprovalRequest,
  ExecutionEvent,
} from "./execution-models";

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
  | "RECOVERY_REQUIRED";

export interface ReleaseDeploymentIntent {
  intentKey: string;
  releaseId: string;
  executionId: string;
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
    // Phase 119: discriminator + rollback linkage.
    intentKind?: "DEPLOY" | "ROLLBACK";
    rollbackTargetReleaseId?: string | null;
    rollbackJobId?: string | null;
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
export class ExecutionStore {
  constructor(private db: NexusEngine) {}

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
      WHERE id = ? AND status NOT IN ('SUCCEEDED', 'CANCELLED', 'DEAD_LETTER', 'BLOCKED')
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

  listJobsByStatus(status: string): ExecutionJob[] {
    return this.db.prepare("SELECT * FROM execution_jobs WHERE status = ?").all(status).map(this.mapJob);
  }

  listJobsDueForRetry(now: number): ExecutionJob[] {
    return this.db.prepare(
      "SELECT * FROM execution_jobs WHERE status = 'RETRY_SCHEDULED' AND next_attempt_at <= ?"
    ).all(now).map(this.mapJob);
  }

  // ---------- Attempts ----------
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
   * Phase 136: worker-authoritative attempt update. WHERE clause carries the
   * same EXISTS(ACTIVE, unexpired, matching lease_id+worker_id+job_id) as
   * updateJobAsOwner and transitionExecution. A stale worker's UPDATE matches
   * zero rows and no attempt evidence is committed.
   */
  updateAttemptAsOwner(
    attempt: ExecutionAttempt,
    leaseId: string,
    workerId: string,
    now: number = Date.now(),
  ): { updated: boolean; reason?: "WORKER_OWNERSHIP_LOST" } {
    const result = this.db.prepare(`
      UPDATE execution_attempts SET
        status = ?, worker_id = ?, lease_id = ?, started_at = ?,
        completed_at = ?, error = ?, evidence = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM execution_leases
          WHERE lease_id = ? AND worker_id = ? AND job_id = ?
            AND status = 'ACTIVE' AND expires_at > ?
        )
    `).run(
      attempt.status,
      attempt.workerId,
      attempt.leaseId,
      attempt.startedAt,
      attempt.completedAt,
      attempt.error,
      attempt.evidence ? JSON.stringify(attempt.evidence) : null,
      attempt.id,
      leaseId,
      workerId,
      attempt.jobId,
      now,
    );
    return result.changes > 0
      ? { updated: true }
      : { updated: false, reason: "WORKER_OWNERSHIP_LOST" };
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
        artifact_id, job_id, release_id, name, type, size_bytes,
        checksum, storage_ref, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.artifactId,
      artifact.jobId,
      artifact.releaseId,
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
        created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEPLOYMENT_INTENT_CREATED', NULL, NULL, NULL, NULL, NULL, ?, ?)
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
    patch: { deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null } = {},
  ): ReleaseDeploymentIntent | undefined {
    this.ensureIntentTable();
    const now = Date.now();
    this.db.prepare(`
      UPDATE release_deployment_intents SET
        status = ?,
        deployment_id = COALESCE(?, deployment_id),
        failure_reason = COALESCE(?, failure_reason),
        recovery_reason = COALESCE(?, recovery_reason),
        updated_at = ?
      WHERE intent_key = ?
    `).run(
      status,
      patch.deploymentId ?? null,
      patch.failureReason ?? null,
      patch.recoveryReason ?? null,
      now,
      intentKey,
    );
    return this.getReleaseIntent(intentKey);
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
      WHERE intent_key = ? AND leased_by = ?
    `).run(expiresAt, now, intentKey, workerId);
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

  private mapReleaseIntent(row: any): ReleaseDeploymentIntent {
    return {
      intentKey: row.intent_key,
      releaseId: row.release_id,
      executionId: row.execution_id,
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
      leasedBy: row.leased_by ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
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
    }}
