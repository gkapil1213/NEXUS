// src/core/engineering-run-event-drainer.ts
// Phase 261: drain worker for the transactional outbox.
//
// Reads pending rows from engineering_run_event_outbox and delivers them
// to engineering_run_events via EngineeringRunService.recordStageExecutionEventWithId.
// Delivery is durable at-least-once; the destination INSERT uses
// ON CONFLICT (event_id) DO NOTHING so retries cannot create duplicates.
//
// Phase 261A hardening:
//   * Claim errors throw (OutboxClaimError) instead of producing an empty
//     success report. Callers can no longer confuse "no work" with
//     "database unreachable".
//   * Malformed payloads are permanently failed with a MALFORMED_PAYLOAD:*
//     last_error. The original payload column is preserved for investigation;
//     nothing is delivered to engineering_run_events.
//   * All ack updates (deliver/retry/permanent-fail) are fenced by
//     claimed_by and inspect the affected-row count. A fence miss (changes=0)
//     is reported as lostClaims, never as delivered/retried/permanentlyFailed.
//
// Phase 262:
//   * claimBatch is now a single PostgreSQL transaction on one connection:
//     SELECT ... FOR UPDATE SKIP LOCKED to partition eligible rows across
//     concurrent workers, then UPDATE ... WHERE outbox_id = ANY(...) to
//     claim exactly the rows this transaction locked. This eliminates the
//     multi-row batch race that the previous single-statement
//     UPDATE...IN(SELECT...) could exhibit under contention. The transaction
//     commits before any delivery attempt runs.

import type { ExecutionStore } from "./execution-store";
import type { EngineeringRunService } from "./engineering-run-service";

export interface DrainReport {
  claimed: number;
  delivered: number;
  retried: number;
  permanentlyFailed: number;
  /** Phase 261A: ack updates whose WHERE fence matched zero rows (we lost
   *  the claim between the SELECT and the UPDATE). These are not errors in
   *  the delivery sense — the row will be re-claimed after lease expiry —
   *  but they must not be counted as successful acknowledgements. */
  lostClaims: number;
}

/** Phase 261A: distinct error type for claim failures so callers can
 *  classify without string-matching. The original cause is preserved on
 *  `cause` for logging. */
export class OutboxClaimError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OutboxClaimError";
  }
}

const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 32;
const DEFAULT_LEASE_MS = 60_000;
const ERROR_TRUNCATE = 500;
const PAYLOAD_ERR_TRUNCATE = 200;

// Exponential backoff in ms: 1s, 4s, 16s, 64s, 256s.
function backoffMs(attempts: number): number {
  return Math.min(1000 * Math.pow(4, attempts - 1), 15 * 60_000);
}

function truncateErr(e: unknown, limit: number = ERROR_TRUNCATE): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > limit ? msg.slice(0, limit) + "..." : msg;
}

interface ClaimedRow {
  outbox_id: string;
  event_id: string;
  run_id: string;
  stage_id: string | null;
  event_type: string;
  payload: string | null;
  attempts: number;
}

export class EngineeringRunEventDrainer {
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly store: ExecutionStore,
    private readonly runService: EngineeringRunService,
    opts?: { workerId?: string; batchSize?: number; leaseMs?: number },
  ) {
    this.workerId = opts?.workerId ?? ("drainer-" + Math.random().toString(36).slice(2, 10));
    this.batchSize = opts?.batchSize ?? DEFAULT_BATCH;
    this.leaseMs = opts?.leaseMs ?? DEFAULT_LEASE_MS;
  }

  async drain(now: number = Date.now()): Promise<DrainReport> {
    const report: DrainReport = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      permanentlyFailed: 0,
      lostClaims: 0,
    };

    let claimed: ClaimedRow[];
    try {
      claimed = await this.claimBatch(now);
    } catch (e) {
      // Phase 261A: do NOT return an empty report on claim failure.
      // A caller cannot distinguish "no work" from "database unreachable"
      // if we do, and that is exactly the failure mode this phase fixes.
      throw new OutboxClaimError(
        "claimBatch failed: " + truncateErr(e, ERROR_TRUNCATE),
        e,
      );
    }
    report.claimed = claimed.length;

    for (const row of claimed) {
      // -------- Payload parsing --------
      // Phase 261A: malformed payload is a permanent, non-retryable failure.
      // We never deliver a fabricated {} and never overwrite the original
      // payload column, so operators can inspect the raw bytes.
      let payload: Record<string, unknown>;
      if (row.payload === null || row.payload === undefined) {
        payload = {};
      } else {
        try {
          const parsed = JSON.parse(row.payload);
          payload = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            ? parsed as Record<string, unknown>
            : {};
        } catch (e) {
          const msg = "MALFORMED_PAYLOAD: " + truncateErr(e, PAYLOAD_ERR_TRUNCATE);
          const attempts = row.attempts + 1;
          const marked = await this.markPermanentlyFailed(row.outbox_id, attempts, msg, now);
          if (marked) report.permanentlyFailed++;
          else report.lostClaims++;
          continue;
        }
      }

      // -------- Delivery --------
      try {
        await this.runService.recordStageExecutionEventWithId(
          row.event_id,
          row.run_id,
          row.stage_id ?? (row.run_id + "__" + row.event_type),
          row.event_type,
          payload,
        );
        const marked = await this.markDelivered(row.outbox_id, now);
        if (marked) report.delivered++;
        else report.lostClaims++;
      } catch (e) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          const marked = await this.markPermanentlyFailed(row.outbox_id, attempts, truncateErr(e), now);
          if (marked) report.permanentlyFailed++;
          else report.lostClaims++;
        } else {
          const marked = await this.scheduleRetry(row.outbox_id, attempts, truncateErr(e), now + backoffMs(attempts));
          if (marked) report.retried++;
          else report.lostClaims++;
        }
      }
    }

    return report;
  }

  /**
   * Phase 262: atomic claim over a single PostgreSQL transaction.
   *
   * Selection, locking, and update all happen on one connection inside
   * one transactionAsync block. `FOR UPDATE SKIP LOCKED` partitions the
   * eligible set across concurrent workers: a row locked by another
   * transaction is skipped, not waited for. The subsequent UPDATE
   * targets exactly the rows this transaction locked (`= ANY(...)`),
   * so two workers can never claim the same row.
   *
   * The transaction commits when the callback returns, before the caller
   * begins delivering the claimed rows. This keeps the claim durable
   * even if the process dies mid-delivery; the row is reclaimed by lease
   * expiry under Phase 261's existing retry semantics.
   *
   * Eligibility conditions are unchanged from Phase 261:
   *   - delivered_at IS NULL
   *   - permanently_failed_at IS NULL
   *   - next_attempt_at IS NULL OR next_attempt_at <= now
   *   - claimed_at IS NULL OR claim_expires_at < now
   * Ordering is unchanged: created_at ASC. Batch size is unchanged:
   * this.batchSize.
   */
  private async claimBatch(now: number): Promise<ClaimedRow[]> {
    const expiresAt = now + this.leaseMs;
    const engine = this.store["asyncDb"];
    if (!engine) {
      throw new OutboxClaimError(
        "claimBatch requires a PostgreSQL async backend " +
        "(NEXUS_PERSISTENCE_MODE=shared). The engineering_run_event_outbox " +
        "table and FOR UPDATE SKIP LOCKED semantics are PostgreSQL-only.",
      );
    }

    return await engine.transactionAsync(async (tx) => {
      // 1. Lock eligible rows. SKIP LOCKED means a concurrent worker's
      //    locked rows are ignored rather than blocked on, so N workers
      //    partition the eligible set without contention.
      const candidates = await tx.prepareAsync(`
        SELECT outbox_id
          FROM engineering_run_event_outbox
         WHERE delivered_at IS NULL
           AND permanently_failed_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (claimed_at IS NULL OR claim_expires_at < ?)
         ORDER BY created_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED
      `).all<{ outbox_id: string }>(now, now, this.batchSize);

      if (candidates.length === 0) return [];

      const ids = candidates.map((r) => r.outbox_id);

      // 2. Claim exactly the rows this transaction locked. `= ANY($1)`
      //    binds the JS string[] as a PostgreSQL text[] parameter.
      const claimed = await tx.prepareAsync(`
        UPDATE engineering_run_event_outbox
           SET claimed_at = ?, claimed_by = ?, claim_expires_at = ?
         WHERE outbox_id = ANY(?)
         RETURNING outbox_id, event_id, run_id, stage_id, event_type, payload, attempts
      `).all<ClaimedRow>(now, this.workerId, expiresAt, ids);

      return claimed;
    });
  }

  /** @returns true iff the UPDATE matched the row this worker still owns. */
  private async markDelivered(outboxId: string, now: number): Promise<boolean> {
    const engine = this.store["asyncDb"];
    if (!engine) return false;
    const r = await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET delivered_at = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(now, outboxId, this.workerId);
    return r.changes > 0;
  }

  /** @returns true iff the UPDATE matched the row this worker still owns. */
  private async scheduleRetry(outboxId: string, attempts: number, lastError: string, nextAttemptAt: number): Promise<boolean> {
    const engine = this.store["asyncDb"];
    if (!engine) return false;
    const r = await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET attempts = ?,
             next_attempt_at = ?,
             last_error = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(attempts, nextAttemptAt, lastError, outboxId, this.workerId);
    return r.changes > 0;
  }

  /** @returns true iff the UPDATE matched the row this worker still owns. */
  private async markPermanentlyFailed(outboxId: string, attempts: number, lastError: string, now: number): Promise<boolean> {
    const engine = this.store["asyncDb"];
    if (!engine) return false;
    const r = await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET attempts = ?,
             last_error = ?,
             permanently_failed_at = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(attempts, lastError, now, outboxId, this.workerId);
    return r.changes > 0;
  }
}
