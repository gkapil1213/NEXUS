// Phase 291: durable handler lifecycle tracking for worker messages.
// Mirrors execution-recovery-operation-store's lease-based CAS primitives.
// A stale owner (lease expired) cannot complete work.

import { NexusEngine } from "./db";

export type HandlerStatus = "LEGACY_UNVERIFIED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED_IN_FLIGHT";

export interface RecoverableMessage {
  messageId: string;
  sessionId: string;
  handlerStatus: HandlerStatus;
  handlerOwnerId: string | null;
  handlerClaimExpiresAt: number | null;
  handlerAttemptCount: number;
  seenAt: number;
}

export class WorkerMessageHandlerTracker {
  constructor(private db: NexusEngine) {}

  claimForProcessing(messageId: string, ownerId: string, leaseMs: number = 60_000): boolean {
    const now = Date.now();
    const expiresAt = now + leaseMs;
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'PROCESSING',
             handler_owner_id = ?,
             handler_claim_expires_at = ?,
             handler_started_at = ?,
             handler_attempt_count = handler_attempt_count + 1
       WHERE message_id = ?
         AND handler_status IN ('PENDING', 'PROCESSING')
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
    `).run(ownerId, expiresAt, now, messageId, now);
    return result.changes === 1;
  }

  markCompleted(messageId: string, ownerId: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'COMPLETED',
             handler_completed_at = ?,
             handler_claim_expires_at = NULL
       WHERE message_id = ?
         AND handler_owner_id = ?
         AND handler_status = 'PROCESSING'
         AND handler_claim_expires_at IS NOT NULL AND handler_claim_expires_at > ?
    `).run(now, messageId, ownerId, now);
    return result.changes === 1;
  }

  markFailedInFlightByOwner(messageId: string, ownerId: string, reason: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'FAILED_IN_FLIGHT',
             handler_last_error = ?,
             handler_claim_expires_at = NULL
       WHERE message_id = ?
         AND handler_owner_id = ?
         AND handler_status = 'PROCESSING'
         AND handler_claim_expires_at IS NOT NULL AND handler_claim_expires_at > ?
    `).run(String(reason).slice(0, 2000), messageId, ownerId, now);
    return result.changes === 1;
  }

  markFailedInFlightByRecovery(messageId: string, reason: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE worker_message_ids
         SET handler_status = 'FAILED_IN_FLIGHT',
             handler_last_error = ?,
             handler_recovery_reason = ?,
             handler_claim_expires_at = NULL
       WHERE message_id = ?
         AND handler_status IN ('PENDING', 'PROCESSING')
         AND (handler_claim_expires_at IS NULL OR handler_claim_expires_at <= ?)
    `).run(String(reason).slice(0, 2000), String(reason).slice(0, 200), messageId, now);
    return result.changes === 1;
  }

  listRecoverable(): RecoverableMessage[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT message_id, session_id, handler_status, handler_owner_id,
             handler_claim_expires_at, handler_attempt_count, seen_at
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
    }));
  }
}