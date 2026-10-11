// src/core/engineering-run-event-drainer.ts
// Phase 261: drain worker for the transactional outbox.
//
// Reads pending rows from engineering_run_event_outbox and delivers them
// to engineering_run_events via EngineeringRunService.recordStageExecutionEventWithId.
// Delivery is durable at-least-once; the destination INSERT uses
// ON CONFLICT (event_id) DO NOTHING so retries cannot create duplicates.
//
// No in-memory coordination state. Multiple workers in different processes
// are safe: a row is claimed by a single UPDATE that filters on
// claim_expires_at, so the loser sees zero rows and moves on.

import type { ExecutionStore } from "./execution-store";
import type { EngineeringRunService } from "./engineering-run-service";

export interface DrainReport {
  claimed: number;
  delivered: number;
  retried: number;
  permanentlyFailed: number;
}

const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 32;
const DEFAULT_LEASE_MS = 60_000;
const ERROR_TRUNCATE = 500;

// Exponential backoff in ms: 1s, 4s, 16s, 64s, 256s.
function backoffMs(attempts: number): number {
  return Math.min(1000 * Math.pow(4, attempts - 1), 15 * 60_000);
}

function truncateErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > ERROR_TRUNCATE ? msg.slice(0, ERROR_TRUNCATE) + "..." : msg;
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
    const report: DrainReport = { claimed: 0, delivered: 0, retried: 0, permanentlyFailed: 0 };

    let claimed: ClaimedRow[];
    try {
      claimed = await this.claimBatch(now);
    } catch {
      // If the outbox table is unavailable (e.g. bootstrap not run yet),
      // return an empty report rather than crashing the caller's tick.
      return report;
    }
    report.claimed = claimed.length;

    for (const row of claimed) {
      const payload = row.payload ? (() => { try { return JSON.parse(row.payload!); } catch { return {}; } })() : {};
      try {
        await this.runService.recordStageExecutionEventWithId(
          row.event_id,
          row.run_id,
          row.stage_id ?? (row.run_id + "__" + row.event_type),
          row.event_type,
          payload,
        );
        await this.markDelivered(row.outbox_id, now);
        report.delivered++;
      } catch (e) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.markPermanentlyFailed(row.outbox_id, attempts, truncateErr(e), now);
          report.permanentlyFailed++;
        } else {
          await this.scheduleRetry(row.outbox_id, attempts, truncateErr(e), now + backoffMs(attempts));
          report.retried++;
        }
      }
    }

    return report;
  }

  private async claimBatch(now: number): Promise<ClaimedRow[]> {
    const expiresAt = now + this.leaseMs;
    const engine = this.store["asyncDb"];
    if (!engine) return [];
    const rows = await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET claimed_at = ?, claimed_by = ?, claim_expires_at = ?
       WHERE outbox_id IN (
         SELECT outbox_id
           FROM engineering_run_event_outbox
          WHERE delivered_at IS NULL
            AND permanently_failed_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (claimed_at IS NULL OR claim_expires_at < ?)
          ORDER BY created_at ASC
          LIMIT ?
       )
       RETURNING outbox_id, event_id, run_id, stage_id, event_type, payload, attempts
    `).all<ClaimedRow>(now, this.workerId, expiresAt, now, now, this.batchSize);
    return rows;
  }

  private async markDelivered(outboxId: string, now: number): Promise<void> {
    const engine = this.store["asyncDb"];
    if (!engine) return;
    await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET delivered_at = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(now, outboxId, this.workerId);
  }

  private async scheduleRetry(outboxId: string, attempts: number, lastError: string, nextAttemptAt: number): Promise<void> {
    const engine = this.store["asyncDb"];
    if (!engine) return;
    await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET attempts = ?,
             next_attempt_at = ?,
             last_error = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(attempts, nextAttemptAt, lastError, outboxId, this.workerId);
  }

  private async markPermanentlyFailed(outboxId: string, attempts: number, lastError: string, now: number): Promise<void> {
    const engine = this.store["asyncDb"];
    if (!engine) return;
    await engine.prepareAsync(`
      UPDATE engineering_run_event_outbox
         SET attempts = ?,
             last_error = ?,
             permanently_failed_at = ?,
             claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL
       WHERE outbox_id = ? AND claimed_by = ?
    `).run(attempts, lastError, now, outboxId, this.workerId);
  }
}