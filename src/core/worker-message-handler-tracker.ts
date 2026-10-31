import { NexusEngine } from "./db";

export type HandlerStatus =
  | "LEGACY_UNVERIFIED"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED_IN_FLIGHT"
  | "RETRY_PENDING"
  | "QUARANTINED";

export interface RecoverableMessage {
  messageId: string;
  sessionId: string;
  handlerStatus: HandlerStatus;
  handlerOwnerId: string | null;
  handlerClaimExpiresAt: number | null;
  handlerAttemptCount: number;
  seenAt: number;
  retryCount: number;
  nextRetryAt: number | null;
  quarantineReason: string | null;
  fencingToken: number;
}

export class WorkerMessageHandlerTracker {
  constructor(private db: NexusEngine) {}

  // The UPDATE and RETURNING are one SQLite statement: callers receive
  // precisely the fencing token assigned to their claim.
  claimForProcessing(
    messageId: string,
    ownerId: string,
    leaseMs: number = 60_000,
  ): boolean {
    return this.claimForProcessingWithToken(messageId, ownerId, leaseMs) !== null;
  }

  claimForProcessingWithToken(
    messageId: string,
    ownerId: string,
    leaseMs: number = 60_000,
  ): number | null {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("invalid_lease_duration");
    }
    const now = Date.now();
    const row = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'PROCESSING',
             handler_owner_id = ?,
             handler_claim_expires_at = ?,
             handler_started_at = ?,
             handler_attempt_count = handler_attempt_count + 1,
             fencing_token = fencing_token + 1
       WHERE message_id = ?
         AND handler_status IN ('PENDING', 'PROCESSING')
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
       RETURNING fencing_token
    `).get(ownerId, now + leaseMs, now, messageId, now) as
      | { fencing_token: number }
      | undefined;
    return row?.fencing_token ?? null;
  }

  markCompleted(
    messageId: string,
    ownerId: string,
    expectedFencingToken: number,
  ): boolean {
    if (!Number.isSafeInteger(expectedFencingToken) || expectedFencingToken < 1) return false;
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'COMPLETED',
             handler_completed_at = ?,
             handler_claim_expires_at = NULL
       WHERE message_id = ?
         AND handler_owner_id = ?
         AND handler_status = 'PROCESSING'
         AND handler_claim_expires_at IS NOT NULL
         AND handler_claim_expires_at > ?
         AND fencing_token = ?
    `).run(now, messageId, ownerId, now, expectedFencingToken);
    return result.changes === 1;
  }

  markFailedInFlightByOwner(
    messageId: string,
    ownerId: string,
    reason: string,
    expectedFencingToken: number,
  ): boolean {
    if (!Number.isSafeInteger(expectedFencingToken) || expectedFencingToken < 1) return false;
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'FAILED_IN_FLIGHT',
             handler_last_error = ?,
             handler_claim_expires_at = NULL,
             fencing_token = fencing_token + 1
       WHERE message_id = ?
         AND handler_owner_id = ?
         AND handler_status = 'PROCESSING'
         AND handler_claim_expires_at IS NOT NULL
         AND handler_claim_expires_at > ?
         AND fencing_token = ?
    `).run(String(reason).slice(0, 2000), messageId, ownerId, now, expectedFencingToken);
    return result.changes === 1;
  }

  markFailedInFlightByRecovery(messageId: string, reason: string, expectedFencingToken: number): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'FAILED_IN_FLIGHT',
             handler_last_error = ?,
             handler_recovery_reason = ?,
             handler_claim_expires_at = NULL,
             fencing_token = fencing_token + 1
       WHERE message_id = ?
         AND handler_status IN ('PENDING', 'PROCESSING')
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
    `).run(
      String(reason).slice(0, 2000),
      String(reason).slice(0, 200),
      messageId,
      now,
    );
    return result.changes === 1;
  }

  getFencingToken(messageId: string): number | undefined {
    const row = this.db.prepare(
      "SELECT fencing_token FROM worker_message_ids WHERE message_id = ?",
    ).get(messageId) as { fencing_token: number } | undefined;
    return row?.fencing_token;
  }

  markRetryPending(
    messageId: string,
    ownerId: string,
    reason: string,
    nextRetryAt: number,
    expectedFencingToken: number,
  ): boolean {
    if (!Number.isSafeInteger(expectedFencingToken) || expectedFencingToken < 1) return false;
    if (!Number.isFinite(nextRetryAt) || nextRetryAt < 0) return false;
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'RETRY_PENDING',
             handler_last_error = ?,
             next_retry_at = ?,
             handler_claim_expires_at = NULL,
             retry_count = retry_count + 1,
             fencing_token = fencing_token + 1
       WHERE message_id = ?
         AND handler_owner_id = ?
         AND handler_status = 'PROCESSING'
         AND handler_claim_expires_at IS NOT NULL
         AND handler_claim_expires_at > ?
         AND fencing_token = ?
    `).run(
      String(reason).slice(0, 2000),
      nextRetryAt,
      messageId,
      ownerId,
      now,
      expectedFencingToken,
    );
    return result.changes === 1;
  }

  markQuarantined(
    messageId: string,
    ownerId: string | null,
    reason: string,
    expectedFencingToken: number,
  ): boolean {
    if (!Number.isSafeInteger(expectedFencingToken) || expectedFencingToken < 1) return false;
    const now = Date.now();
    const boundedReason = String(reason).slice(0, 200);
    const boundedError = String(reason).slice(0, 2000);

    const result = ownerId !== null
      ? this.db.prepare(`
          UPDATE worker_message_ids
             SET handler_status = 'QUARANTINED',
                 quarantine_reason = ?,
                 handler_last_error = ?,
                 handler_claim_expires_at = NULL,
                 fencing_token = fencing_token + 1
           WHERE message_id = ?
             AND handler_owner_id = ?
             AND handler_status = 'PROCESSING'
             AND handler_claim_expires_at IS NOT NULL
             AND handler_claim_expires_at > ?
             AND fencing_token = ?
        `).run(boundedReason, boundedError, messageId, ownerId, now, expectedFencingToken)
      : this.db.prepare(`
          UPDATE worker_message_ids
             SET handler_status = 'QUARANTINED',
                 quarantine_reason = ?,
                 handler_recovery_reason = ?,
                 handler_claim_expires_at = NULL,
                 fencing_token = fencing_token + 1
           WHERE message_id = ?
             AND handler_status IN ('PENDING', 'PROCESSING', 'RETRY_PENDING', 'FAILED_IN_FLIGHT')
             AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
             AND fencing_token = ?
        `).run(boundedReason, boundedReason, messageId, now, expectedFencingToken);

    return result.changes === 1;
  }

  claimForReplay(
    messageId: string,
    ownerId: string,
    leaseMs: number = 60_000,
  ): number | null {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("invalid_lease_duration");
    }
    const now = Date.now();
    const row = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'PROCESSING',
             handler_owner_id = ?,
             handler_claim_expires_at = ?,
             handler_started_at = ?,
             handler_attempt_count = handler_attempt_count + 1,
             fencing_token = fencing_token + 1
       WHERE message_id = ?
         AND handler_status = 'RETRY_PENDING'
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= ?
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
       RETURNING fencing_token
    `).get(ownerId, now + leaseMs, now, messageId, now, now) as
      | { fencing_token: number }
      | undefined;
    return row?.fencing_token ?? null;
  }

  listRetryDue(): RecoverableMessage[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT message_id, session_id, handler_status, handler_owner_id,
             handler_claim_expires_at, handler_attempt_count, seen_at,
             retry_count, next_retry_at, quarantine_reason, fencing_token
        FROM worker_message_ids
       WHERE handler_status = 'RETRY_PENDING'
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= ?
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
       ORDER BY next_retry_at ASC
    `).all(now, now) as any[];

    return rows.map((r) => ({
      messageId: r.message_id,
      sessionId: r.session_id,
      handlerStatus: r.handler_status,
      handlerOwnerId: r.handler_owner_id,
      handlerClaimExpiresAt: r.handler_claim_expires_at,
      handlerAttemptCount: r.handler_attempt_count,
      seenAt: r.seen_at,
      retryCount: r.retry_count ?? 0,
      nextRetryAt: r.next_retry_at,
      quarantineReason: r.quarantine_reason,
      fencingToken: r.fencing_token,
    }));
  }

  listRecoverable(): RecoverableMessage[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT message_id, session_id, handler_status, handler_owner_id,
             handler_claim_expires_at, handler_attempt_count, seen_at,
             retry_count, next_retry_at, quarantine_reason, fencing_token
        FROM worker_message_ids
       WHERE handler_status IN ('PENDING', 'PROCESSING')
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
       ORDER BY seen_at ASC
    `).all(now) as any[];

    return rows.map((r) => ({
      messageId: r.message_id,
      sessionId: r.session_id,
      handlerStatus: r.handler_status,
      handlerOwnerId: r.handler_owner_id,
      handlerClaimExpiresAt: r.handler_claim_expires_at,
      handlerAttemptCount: r.handler_attempt_count,
      seenAt: r.seen_at,
      retryCount: r.retry_count ?? 0,
      nextRetryAt: r.next_retry_at ?? null,
      quarantineReason: r.quarantine_reason ?? null,
      fencingToken: r.fencing_token,
    }));
  }
}
