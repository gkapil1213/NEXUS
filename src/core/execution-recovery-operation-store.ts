// src/core/execution-recovery-operation-store.ts
//
// Phase 144: durable execution recovery operations.
//
// Persists every recoverStaleJobs() recovery attempt so a crash between
// multi-step transitions (e.g. FAILED -> RETRY_SCHEDULED) can be resumed by
// reconciliation without fabricating success.
//
// Claim fencing: every mark* mutation requires the caller to present the
// current claim_owner AND a non-expired claim_expires_at. A stale owner whose
// claim was reclaimed by another worker will receive false and must not
// mutate the operation. This prevents "worker A completes worker B's
// operation" races after claim expiry.

import { NexusEngine } from "./db";

export type ExecutionRecoveryOperationType =
  | "CANCELLATION"
  | "TIMEOUT"
  | "ORPHAN_RECOVERY"
  | "REQUEUE"
  | "DEAD_LETTER";

export type ExecutionRecoveryOperationState =
  | "PENDING"
  | "CLAIMED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "RECOVERY_REQUIRED"
  | "CANCELLED";

export interface ExecutionRecoveryOperation {
  operationId: string;
  jobId: string;
  leaseId: string | null;
  workerId: string | null;
  operationType: ExecutionRecoveryOperationType;
  state: ExecutionRecoveryOperationState;
  idempotencyKey: string;
  attemptCount: number;
  lastError: string | null;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function mapRow(row: any): ExecutionRecoveryOperation {
  return {
    operationId: row.operation_id,
    jobId: row.job_id,
    leaseId: row.lease_id ?? null,
    workerId: row.worker_id ?? null,
    operationType: row.operation_type,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? null,
    claimOwner: row.claim_owner ?? null,
    claimExpiresAt: row.claim_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

export function recoveryOperationIdempotencyKey(input: {
  jobId: string;
  leaseId: string | null;
  operationType: ExecutionRecoveryOperationType;
}): string {
  return input.operationType + ":" + input.jobId + ":" + (input.leaseId ?? "no-lease");
}

export class ExecutionRecoveryOperationStore {
  constructor(private db: NexusEngine) {}

  createOrGetOperation(input: {
    jobId: string;
    leaseId: string | null;
    workerId: string | null;
    operationType: ExecutionRecoveryOperationType;
    idempotencyKey?: string;
    now?: number;
  }): { operation: ExecutionRecoveryOperation; created: boolean } {
    const now = input.now ?? Date.now();
    const key =
      input.idempotencyKey ??
      recoveryOperationIdempotencyKey({
        jobId: input.jobId,
        leaseId: input.leaseId,
        operationType: input.operationType,
      });

    const existing = this.db
      .prepare("SELECT * FROM execution_recovery_operations WHERE idempotency_key = ?")
      .get(key) as any;
    if (existing) return { operation: mapRow(existing), created: false };

    const operationId = generateId();
    try {
      this.db
        .prepare(
          "INSERT INTO execution_recovery_operations " +
          "(operation_id, job_id, lease_id, worker_id, operation_type, state, " +
          " idempotency_key, attempt_count, last_error, claim_owner, " +
          " claim_expires_at, created_at, updated_at, completed_at) " +
          "VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 0, NULL, NULL, NULL, ?, ?, NULL)"
        )
        .run(
          operationId,
          input.jobId,
          input.leaseId,
          input.workerId,
          input.operationType,
          key,
          now,
          now
        );
      const row = this.db
        .prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?")
        .get(operationId) as any;
      return { operation: mapRow(row), created: true };
    } catch (err) {
      const winner = this.db
        .prepare("SELECT * FROM execution_recovery_operations WHERE idempotency_key = ?")
        .get(key) as any;
      if (winner) return { operation: mapRow(winner), created: false };
      throw err;
    }
  }

  getOperation(operationId: string): ExecutionRecoveryOperation | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_recovery_operations WHERE operation_id = ?")
      .get(operationId) as any;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Atomic CAS claim. Eligible source states:
   *   PENDING
   *   FAILED
   *   RECOVERY_REQUIRED
   *   CLAIMED / IN_PROGRESS where claim_expires_at has passed (stale claim)
   *
   * COMPLETED is never reclaimable. attempt_count increments only on a
   * successful claim, not on createOrGet.
   */
  claimOperation(input: {
    operationId: string;
    owner: string;
    durationMs: number;
    now?: number;
  }): { claimed: boolean; operation?: ExecutionRecoveryOperation; reason?: string } {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.durationMs;

    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'CLAIMED', " +
        "       claim_owner = ?, " +
        "       claim_expires_at = ?, " +
        "       attempt_count = attempt_count + 1, " +
        "       updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND (state = 'PENDING' " +
        "        OR state = 'FAILED' " +
        "        OR state = 'RECOVERY_REQUIRED' " +
        "        OR (state IN ('CLAIMED','IN_PROGRESS') " +
        "            AND (claim_expires_at IS NULL OR claim_expires_at <= ?)))"
      )
      .run(input.owner, expiresAt, now, input.operationId, now);

    if (result.changes === 1) {
      return { claimed: true, operation: this.getOperation(input.operationId) };
    }

    const current = this.getOperation(input.operationId);
    if (!current) return { claimed: false, reason: "NOT_FOUND" };
    if (current.state === "COMPLETED") return { claimed: false, operation: current, reason: "ALREADY_COMPLETED" };
    return { claimed: false, operation: current, reason: "ACTIVE_CLAIM" };
  }

  markInProgress(operationId: string, owner: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'IN_PROGRESS', updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
        "   AND state = 'CLAIMED'"
      )
      .run(now, operationId, owner, now);
    return result.changes === 1;
  }

  markCompleted(operationId: string, owner: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'COMPLETED', " +
        "       claim_owner = NULL, " +
        "       claim_expires_at = NULL, " +
        "       completed_at = ?, " +
        "       updated_at = ?, " +
        "       last_error = NULL " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
        "   AND state IN ('CLAIMED','IN_PROGRESS')"
      )
      .run(now, now, operationId, owner, now);
    return result.changes === 1;
  }

  /**
   * Phase 151: finalize an operation whose authoritative postcondition is
   * already satisfied in the job, without consuming an additional recovery
   * attempt.
   *
   * Used by reconciliation when a crash-after-commit left the operation
   * incomplete: the job mutation committed, but the process died before
   * markCompleted() ran.
   *
   * Semantics:
   *   - Transitions PENDING|CLAIMED|IN_PROGRESS|FAILED to COMPLETED.
   *   - Does NOT increment attempt_count.
   *   - Refuses if a live claim exists (claim_expires_at > now), so the
   *     original owner is not preempted while still active.
   *   - Idempotent: repeated calls are no-ops once COMPLETED.
   */
  finalizeCompletedOperation(operationId: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'COMPLETED', " +
        "       claim_owner = NULL, " +
        "       claim_expires_at = NULL, " +
        "       completed_at = ?, " +
        "       updated_at = ?, " +
        "       last_error = NULL " +
        " WHERE operation_id = ? " +
        "   AND state IN ('PENDING','CLAIMED','IN_PROGRESS','FAILED') " +
        "   AND (claim_expires_at IS NULL OR claim_expires_at <= ?)"
      )
      .run(now, now, operationId, now);
    return result.changes === 1;
  }

  markFailed(operationId: string, owner: string, error: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'FAILED', " +
        "       claim_owner = NULL, " +
        "       claim_expires_at = NULL, " +
        "       last_error = ?, " +
        "       updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
        "   AND state IN ('CLAIMED','IN_PROGRESS')"
      )
      .run(String(error).slice(0, 2000), now, operationId, owner, now);
    return result.changes === 1;
  }

  markRecoveryRequired(operationId: string, owner: string, error: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'RECOVERY_REQUIRED', " +
        "       claim_owner = NULL, " +
        "       claim_expires_at = NULL, " +
        "       last_error = ?, " +
        "       updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
        "   AND state IN ('CLAIMED','IN_PROGRESS')"
      )
      .run(String(error).slice(0, 2000), now, operationId, owner, now);
    return result.changes === 1;
  }

  /**
   * Phase 153: atomic lease renewal for an active claim.
   *
   * Extends claim_expires_at only when the caller still holds the claim and
   * the claim is still live. This is a single conditional UPDATE — the CAS
   * predicate is the authoritative ownership check.
   *
   * Distinguishes:
   *   renewed: true                      ownership preserved, expiry extended
   *   renewed: false, reason NOT_FOUND   no such operation
   *   renewed: false, reason TERMINAL    COMPLETED | FAILED | RECOVERY_REQUIRED
   *   renewed: false, reason OWNERSHIP_LOST  another owner holds the claim
   *   renewed: false, reason EXPIRED     caller's claim has lapsed; must re-claim
   *
   * Renewal does NOT increment attempt_count and does NOT touch any state
   * other than claim_expires_at and updated_at.
   */
  renewOperationClaim(input: {
    operationId: string;
    owner: string;
    durationMs: number;
    now?: number;
  }): {
    renewed: boolean;
    reason?: "NOT_FOUND" | "OWNERSHIP_LOST" | "TERMINAL" | "EXPIRED";
    operation?: ExecutionRecoveryOperation;
    expiresAt?: number;
  } {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.durationMs;

    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET claim_expires_at = ?, updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND state IN ('CLAIMED','IN_PROGRESS') " +
        "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ?"
      )
      .run(expiresAt, now, input.operationId, input.owner, now);

    if (result.changes === 1) {
      return { renewed: true, operation: this.getOperation(input.operationId), expiresAt };
    }

    const current = this.getOperation(input.operationId);
    if (!current) return { renewed: false, reason: "NOT_FOUND" };
    if (
      current.state === "COMPLETED" ||
      current.state === "FAILED" ||
      current.state === "RECOVERY_REQUIRED" ||
      current.state === "CANCELLED"
    ) {
      return { renewed: false, reason: "TERMINAL", operation: current };
    }
    if (current.claimOwner !== input.owner) {
      return { renewed: false, reason: "OWNERSHIP_LOST", operation: current };
    }
    return { renewed: false, reason: "EXPIRED", operation: current };
  }

  /**
   * Phase 154: owner-fenced, CAS-gated cancellation of an active claim.
   *
   * The current claim owner abandons its recovery operation. The job state is
   * NOT touched. The operation transitions to CANCELLED and is excluded from
   * listResumableOperations(), so reconciliation will not pick it up again.
   *
   * Does NOT increment attempt_count.
   */
  cancelOperationClaim(input: {
    operationId: string;
    owner: string;
    now?: number;
  }): {
    cancelled: boolean;
    alreadyCancelled?: boolean;
    reason?: "NOT_FOUND" | "TERMINAL" | "OWNERSHIP_LOST" | "EXPIRED" | "NOT_CLAIMED";
    operation?: ExecutionRecoveryOperation;
  } {
    const now = input.now ?? Date.now();
    const result = this.db
      .prepare(
        "UPDATE execution_recovery_operations " +
        "   SET state = 'CANCELLED', " +
        "       claim_owner = NULL, " +
        "       claim_expires_at = NULL, " +
        "       completed_at = ?, " +
        "       updated_at = ? " +
        " WHERE operation_id = ? " +
        "   AND claim_owner = ? " +
        "   AND claim_expires_at IS NOT NULL " +
        "   AND claim_expires_at > ? " +
        "   AND state IN ('CLAIMED','IN_PROGRESS')"
      )
      .run(now, now, input.operationId, input.owner, now);

    if (result.changes === 1) {
      return { cancelled: true, operation: this.getOperation(input.operationId) };
    }

    const current = this.getOperation(input.operationId);
    if (!current) return { cancelled: false, reason: "NOT_FOUND" };
    if (current.state === "CANCELLED") {
      return { cancelled: true, alreadyCancelled: true, operation: current };
    }
    if (
      current.state === "COMPLETED" ||
      current.state === "FAILED" ||
      current.state === "RECOVERY_REQUIRED"
    ) {
      return { cancelled: false, reason: "TERMINAL", operation: current };
    }
    if (current.claimOwner !== input.owner) {
      return { cancelled: false, reason: "OWNERSHIP_LOST", operation: current };
    }
    if (current.claimExpiresAt !== null && current.claimExpiresAt <= now) {
      return { cancelled: false, reason: "EXPIRED", operation: current };
    }
    return { cancelled: false, reason: "NOT_CLAIMED", operation: current };
  }

  listIncompleteOperations(): ExecutionRecoveryOperation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM execution_recovery_operations " +
        " WHERE state IN ('PENDING','CLAIMED','IN_PROGRESS') " +
        " ORDER BY created_at ASC"
      )
      .all() as any[];
    return rows.map(mapRow);
  }

  /**
   * Phase 145: operations that reconciliation should consider resuming.
   *
   * Extends listIncompleteOperations() with FAILED. claimOperation() already
   * accepts FAILED -> CLAIMED, but listIncompleteOperations() filtered FAILED
   * out, so a single transient failure during a recovery body left the
   * operation - and the job it was recovering - permanently stalled.
   *
   * RECOVERY_REQUIRED stays excluded: it is a deliberate operator signal and
   * must not be auto-retried.
   */
  listResumableOperations(): ExecutionRecoveryOperation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM execution_recovery_operations " +
        " WHERE state IN ('PENDING','CLAIMED','IN_PROGRESS') " +
        "    OR state = 'FAILED' " +
        " ORDER BY created_at ASC"
      )
      .all() as any[];
    return rows.map(mapRow);
  }
}

// ============================================================
// Phase 183b: async sibling of ExecutionRecoveryOperationStore.
//
// Same SQL, same state semantics, same claim fencing. Routes through an
// AsyncNexusEngine so it can run against PostgreSQL in shared mode.
// ============================================================

import { AsyncNexusEngine } from "./db";

export class AsyncExecutionRecoveryOperationStore {
  constructor(private asyncDb: AsyncNexusEngine) {}

  async createOrGetOperation(input: {
    jobId: string;
    leaseId: string | null;
    workerId: string | null;
    operationType: ExecutionRecoveryOperationType;
    idempotencyKey?: string;
    now?: number;
  }): Promise<{ operation: ExecutionRecoveryOperation; created: boolean }> {
    const now = input.now ?? Date.now();
    const key =
      input.idempotencyKey ??
      recoveryOperationIdempotencyKey({
        jobId: input.jobId,
        leaseId: input.leaseId,
        operationType: input.operationType,
      });

    const existing = await this.asyncDb.prepareAsync(
      "SELECT * FROM execution_recovery_operations WHERE idempotency_key = ?",
    ).get<any>(key);
    if (existing) return { operation: mapRow(existing), created: false };

    const operationId = generateId();
    try {
      await this.asyncDb.prepareAsync(
        "INSERT INTO execution_recovery_operations " +
        "(operation_id, job_id, lease_id, worker_id, operation_type, state, " +
        " idempotency_key, attempt_count, last_error, claim_owner, " +
        " claim_expires_at, created_at, updated_at, completed_at) " +
        "VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 0, NULL, NULL, NULL, ?, ?, NULL)",
      ).run(
        operationId,
        input.jobId,
        input.leaseId,
        input.workerId,
        input.operationType,
        key,
        now,
        now,
      );
      const row = await this.asyncDb.prepareAsync(
        "SELECT * FROM execution_recovery_operations WHERE operation_id = ?",
      ).get<any>(operationId);
      return { operation: mapRow(row), created: true };
    } catch (err) {
      const winner = await this.asyncDb.prepareAsync(
        "SELECT * FROM execution_recovery_operations WHERE idempotency_key = ?",
      ).get<any>(key);
      if (winner) return { operation: mapRow(winner), created: false };
      throw err;
    }
  }

  async getOperation(operationId: string): Promise<ExecutionRecoveryOperation | undefined> {
    const row = await this.asyncDb.prepareAsync(
      "SELECT * FROM execution_recovery_operations WHERE operation_id = ?",
    ).get<any>(operationId);
    return row ? mapRow(row) : undefined;
  }

  async claimOperation(input: {
    operationId: string;
    owner: string;
    durationMs: number;
    now?: number;
  }): Promise<{ claimed: boolean; operation?: ExecutionRecoveryOperation; reason?: string }> {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.durationMs;
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'CLAIMED', " +
      "       claim_owner = ?, " +
      "       claim_expires_at = ?, " +
      "       attempt_count = attempt_count + 1, " +
      "       updated_at = ? " +
      " WHERE operation_id = ? " +
      "   AND (state = 'PENDING' " +
      "        OR state = 'FAILED' " +
      "        OR state = 'RECOVERY_REQUIRED' " +
      "        OR (state IN ('CLAIMED','IN_PROGRESS') " +
      "            AND (claim_expires_at IS NULL OR claim_expires_at <= ?)))",
    ).run(input.owner, expiresAt, now, input.operationId, now);

    if (r.changes === 1) {
      return { claimed: true, operation: await this.getOperation(input.operationId) };
    }
    const current = await this.getOperation(input.operationId);
    if (!current) return { claimed: false, reason: "NOT_FOUND" };
    if (current.state === "COMPLETED") return { claimed: false, operation: current, reason: "ALREADY_COMPLETED" };
    return { claimed: false, operation: current, reason: "ACTIVE_CLAIM" };
  }

  async markInProgress(operationId: string, owner: string, now: number = Date.now()): Promise<boolean> {
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'IN_PROGRESS', updated_at = ? " +
      " WHERE operation_id = ? " +
      "   AND claim_owner = ? " +
      "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
      "   AND state = 'CLAIMED'",
    ).run(now, operationId, owner, now);
    return r.changes === 1;
  }

  async markCompleted(operationId: string, owner: string, now: number = Date.now()): Promise<boolean> {
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'COMPLETED', " +
      "       claim_owner = NULL, " +
      "       claim_expires_at = NULL, " +
      "       completed_at = ?, " +
      "       updated_at = ?, " +
      "       last_error = NULL " +
      " WHERE operation_id = ? " +
      "   AND claim_owner = ? " +
      "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
      "   AND state IN ('CLAIMED','IN_PROGRESS')",
    ).run(now, now, operationId, owner, now);
    return r.changes === 1;
  }

  async finalizeCompletedOperation(operationId: string, now: number = Date.now()): Promise<boolean> {
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'COMPLETED', " +
      "       claim_owner = NULL, " +
      "       claim_expires_at = NULL, " +
      "       completed_at = ?, " +
      "       updated_at = ?, " +
      "       last_error = NULL " +
      " WHERE operation_id = ? " +
      "   AND state IN ('PENDING','CLAIMED','IN_PROGRESS','FAILED') " +
      "   AND (claim_expires_at IS NULL OR claim_expires_at <= ?)",
    ).run(now, now, operationId, now);
    return r.changes === 1;
  }

  async markFailed(
    operationId: string,
    owner: string,
    error: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'FAILED', " +
      "       claim_owner = NULL, " +
      "       claim_expires_at = NULL, " +
      "       last_error = ?, " +
      "       updated_at = ? " +
      " WHERE operation_id = ? " +
      "   AND claim_owner = ? " +
      "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
      "   AND state IN ('CLAIMED','IN_PROGRESS')",
    ).run(error, now, operationId, owner, now);
    return r.changes === 1;
  }

  async markRecoveryRequired(
    operationId: string,
    owner: string,
    error: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    const r = await this.asyncDb.prepareAsync(
      "UPDATE execution_recovery_operations " +
      "   SET state = 'RECOVERY_REQUIRED', " +
      "       claim_owner = NULL, " +
      "       claim_expires_at = NULL, " +
      "       last_error = ?, " +
      "       updated_at = ? " +
      " WHERE operation_id = ? " +
      "   AND claim_owner = ? " +
      "   AND claim_expires_at IS NOT NULL AND claim_expires_at > ? " +
      "   AND state IN ('CLAIMED','IN_PROGRESS')",
    ).run(String(error).slice(0, 2000), now, operationId, owner, now);
    return r.changes === 1;
  }
}