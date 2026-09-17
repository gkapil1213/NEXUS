// src/core/ci-reconciliation-ownership.service.ts
//
// Phase 134: singleton durable ownership of the CI reconciliation scheduler
// across multiple NEXUS instances. At most one worker holds ownership at a
// time, enforced by a partial unique index. Ownership expires via expires_at
// so a crashed owner never wedges the scheduler permanently.
//
// This is deliberately NOT a second LeaseManager. The execution lease table
// models job ownership; this models scheduler ownership. Different domain,
// different table, different lifecycle.
//
// Worker identity convention (matches kernel.ts recoveryWorkerId):
//   "nexus-cicd-scheduler-" + crypto.randomUUID()
// One per process instance, generated once at boot. Distinct from leaseId
// which is generated per successful acquisition.

// No node:crypto import. This module is transitively reachable from the
// browser bundle via kernel.ts; Vite externalizes node:crypto to a stub with
// no named exports, which Rollup rejects at build time. Use the Web Crypto
// global instead (present in Node 19+ and every modern browser).

export const CI_RECONCILIATION_OWNERSHIP_ID = "ci-reconciliation-scheduler";
export const DEFAULT_CI_OWNERSHIP_TTL_MS = 90_000;

export interface OwnershipEventSink {
  emit(input: {
    type: string;
    source?: string;
    execution_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

export interface OwnershipAuditSink {
  record(input: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

export interface OwnershipSqliteStatement {
  get(...a: unknown[]): unknown;
  run(...a: unknown[]): { changes: number };
}
export interface OwnershipSqliteDb {
  prepare(sql: string): OwnershipSqliteStatement;
}

export type OwnershipFailureReason =
  | "held-by-other"
  | "renewal-failed"
  | "ownership-lost"
  | "db-error"
  | "race-lost";

export interface OwnershipState {
  owned: boolean;
  reason?: OwnershipFailureReason;
  workerId: string;
  leaseId: string | null;
  holder: string | null;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
}

export interface OwnershipInspection {
  holder: string | null;
  leaseId: string | null;
  state: "ACTIVE" | "RELEASED" | "EXPIRED" | "NONE";
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
}

export interface FencingContext {
  ownershipId: string;
  workerId: string;
  leaseId: string;
  now: () => number;
}

export interface OwnershipServiceOptions {
  ttlMs?: number;
  now?: () => number;
}

const SOURCE = "CiReconciliationOwnership";

/**
 * Generate a unique lease identifier.
 *
 * Prefers Web Crypto (globalThis.crypto, present in Node 19+ and every
 * modern browser). A fallback path exists for hypothetical older runtimes;
 * lease identifiers require uniqueness, not cryptographic unpredictability.
 */
function generateLeaseId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return "cilease_" + c.randomUUID();
  return "cilease_" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

export class CiReconciliationOwnershipService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly workerId: string;
  private localLeaseId: string | null = null;
  private localAcquiredAt: number | null = null;
  private lastErr: string | null = null;

  constructor(
    private readonly db: OwnershipSqliteDb,
    workerId: string,
    private readonly events?: OwnershipEventSink,
    private readonly audit?: OwnershipAuditSink,
    opts: OwnershipServiceOptions = {},
  ) {
    if (!workerId) throw new Error("CiReconciliationOwnershipService requires a stable workerId");
    this.workerId = workerId;
    this.ttlMs = Math.max(1_000, opts.ttlMs ?? DEFAULT_CI_OWNERSHIP_TTL_MS);
    this.now = opts.now ?? Date.now;
  }

  workerIdValue(): string { return this.workerId; }
  currentLeaseId(): string | null { return this.localLeaseId; }
  currentTtlMs(): number { return this.ttlMs; }

  currentOwnershipId(): string { return CI_RECONCILIATION_OWNERSHIP_ID; }

  /**
   * Phase 135: synchronous ownership check used by callers that must fence a
   * durable mutation immediately before it happens (ArtifactService.register).
   * Returns true only when this instance currently holds an ACTIVE, unexpired
   * lease on the singleton ownership row.
   */
  isOwnedNowSync(): boolean {
    if (!this.localLeaseId) return false;
    const t = this.now();
    const row = this.db.prepare(
      "SELECT 1 FROM ci_reconciliation_worker_ownership " +
      "WHERE ownership_id = ? AND worker_id = ? AND lease_id = ? " +
      "AND state = 'ACTIVE' AND expires_at > ?"
    ).get(CI_RECONCILIATION_OWNERSHIP_ID, this.workerId, this.localLeaseId, t);
    return row !== undefined;
  }

  currentFence(): FencingContext | null {
    if (!this.localLeaseId) return null;
    return {
      ownershipId: CI_RECONCILIATION_OWNERSHIP_ID,
      workerId: this.workerId,
      leaseId: this.localLeaseId,
      now: this.now,
    };
  }
  lastOwnershipError(): string | null { return this.lastErr; }

  /**
   * Idempotent. Expire stale rows, then either renew (if we already hold) or
   * attempt acquire. Never throws on ordinary contention; returns an
   * OwnershipState instead. Emits ownership.* events.
   */
  async ensureOwned(): Promise<OwnershipState> {
    const t = this.now();

    try {
      // 1. Expire any ACTIVE row past its expires_at.
      const wasOurs = this.localLeaseId;
      this.db.prepare(
        "UPDATE ci_reconciliation_worker_ownership " +
        "SET state = 'EXPIRED', updated_at = ? " +
        "WHERE ownership_id = ? AND state = 'ACTIVE' AND expires_at <= ?"
      ).run(t, CI_RECONCILIATION_OWNERSHIP_ID, t);

      // 2. Read the ACTIVE row (if any).
      const activeRow = this.db.prepare(
        "SELECT worker_id, lease_id, acquired_at, renewed_at, expires_at " +
        "FROM ci_reconciliation_worker_ownership " +
        "WHERE ownership_id = ? AND state = 'ACTIVE'"
      ).get(CI_RECONCILIATION_OWNERSHIP_ID) as
        | { worker_id: string; lease_id: string; acquired_at: number; renewed_at: number; expires_at: number }
        | undefined;

      // 3. No active row → try to acquire.
      if (!activeRow) {
        if (wasOurs) {
          this.localLeaseId = null;
          this.localAcquiredAt = null;
          await this.emit("ownership.lost", { workerId: this.workerId, reason: "expired" });
        }
        return await this.tryAcquire(t);
      }

      // 4. Row is ours → renew.
      if (activeRow.worker_id === this.workerId && activeRow.lease_id === this.localLeaseId) {
        const newExpires = t + this.ttlMs;
        const changes = this.db.prepare(
          "UPDATE ci_reconciliation_worker_ownership " +
          "SET renewed_at = ?, expires_at = ?, updated_at = ? " +
          "WHERE ownership_id = ? AND worker_id = ? AND lease_id = ? " +
          "AND state = 'ACTIVE' AND expires_at > ?"
        ).run(t, newExpires, t, CI_RECONCILIATION_OWNERSHIP_ID, this.workerId, this.localLeaseId, t).changes;

        if (changes > 0) {
          this.lastErr = null;
          await this.emit("ownership.renewed", {
            workerId: this.workerId, leaseId: this.localLeaseId, expiresAt: newExpires,
          });
          return {
            owned: true,
            workerId: this.workerId,
            leaseId: this.localLeaseId,
            holder: this.workerId,
            acquiredAt: this.localAcquiredAt,
            renewedAt: t,
            expiresAt: newExpires,
          };
        }
        // CAS miss — someone else took over.
        this.localLeaseId = null;
        this.localAcquiredAt = null;
        this.lastErr = "renewal-failed: cas miss";
        await this.emit("ownership.renewal_failed", { workerId: this.workerId, reason: "cas-miss" });
        await this.emit("ownership.lost", { workerId: this.workerId, reason: "cas-miss" });
        return {
          owned: false,
          reason: "ownership-lost",
          workerId: this.workerId,
          leaseId: null,
          holder: activeRow.worker_id,
          acquiredAt: activeRow.acquired_at,
          renewedAt: activeRow.renewed_at,
          expiresAt: activeRow.expires_at,
        };
      }

      // 5. Held by another worker.
      await this.emit("ownership.not_acquired", {
        workerId: this.workerId, holder: activeRow.worker_id, expiresAt: activeRow.expires_at,
      });
      return {
        owned: false,
        reason: "held-by-other",
        workerId: this.workerId,
        leaseId: null,
        holder: activeRow.worker_id,
        acquiredAt: activeRow.acquired_at,
        renewedAt: activeRow.renewed_at,
        expiresAt: activeRow.expires_at,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      this.lastErr = msg;
      await this.emit("ownership.renewal_failed", { workerId: this.workerId, reason: "db-error", error: msg });
      return {
        owned: false,
        reason: "db-error",
        workerId: this.workerId,
        leaseId: this.localLeaseId,
        holder: null,
        acquiredAt: null,
        renewedAt: null,
        expiresAt: null,
      };
    }
  }

  /** Best-effort release. Never throws (safe from shutdown paths). */
  async release(): Promise<void> {
    const leaseId = this.localLeaseId;
    if (!leaseId) return;
    const t = this.now();
    try {
      const changes = this.db.prepare(
        "UPDATE ci_reconciliation_worker_ownership " +
        "SET state = 'RELEASED', released_at = ?, updated_at = ? " +
        "WHERE ownership_id = ? AND worker_id = ? AND lease_id = ? AND state = 'ACTIVE'"
      ).run(t, t, CI_RECONCILIATION_OWNERSHIP_ID, this.workerId, leaseId).changes;
      if (changes > 0) {
        await this.emit("ownership.released", { workerId: this.workerId, leaseId });
      }
    } catch (e) {
      this.lastErr = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    } finally {
      this.localLeaseId = null;
      this.localAcquiredAt = null;
    }
  }

  /** Durable inspect — independent of local memory. */
  inspect(): OwnershipInspection {
    const row = this.db.prepare(
      "SELECT worker_id, lease_id, state, acquired_at, renewed_at, expires_at " +
      "FROM ci_reconciliation_worker_ownership " +
      "WHERE ownership_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(CI_RECONCILIATION_OWNERSHIP_ID) as
      | { worker_id: string; lease_id: string; state: string; acquired_at: number; renewed_at: number; expires_at: number }
      | undefined;
    if (!row) return { holder: null, leaseId: null, state: "NONE", acquiredAt: null, renewedAt: null, expiresAt: null };
    return {
      holder: row.worker_id,
      leaseId: row.lease_id,
      state: row.state as "ACTIVE" | "RELEASED" | "EXPIRED",
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      expiresAt: row.expires_at,
    };
  }

  // --- internals ---

  private async tryAcquire(t: number): Promise<OwnershipState> {
    await this.emit("ownership.acquire.attempt", { workerId: this.workerId });
    const leaseId = generateLeaseId();
    const expiresAt = t + this.ttlMs;

    try {
      // Singleton row + PK on ownership_id. A plain INSERT fails once the row
      // has ever existed (RELEASED / EXPIRED). UPSERT with a WHERE guard:
      // overwrite only when the existing row is not ACTIVE. When the row IS
      // ACTIVE (a live holder), the DO UPDATE is skipped (changes === 0),
      // which is treated as a race loss without any write having occurred.
      const changes = this.db.prepare(
        "INSERT INTO ci_reconciliation_worker_ownership " +
        "(ownership_id, worker_id, lease_id, state, acquired_at, renewed_at, expires_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?) " +
        "ON CONFLICT(ownership_id) DO UPDATE SET " +
        "  worker_id = excluded.worker_id, " +
        "  lease_id = excluded.lease_id, " +
        "  state = 'ACTIVE', " +
        "  acquired_at = excluded.acquired_at, " +
        "  renewed_at = excluded.renewed_at, " +
        "  expires_at = excluded.expires_at, " +
        "  released_at = NULL, " +
        "  updated_at = excluded.updated_at " +
        "WHERE ci_reconciliation_worker_ownership.state != 'ACTIVE'"
      ).run(CI_RECONCILIATION_OWNERSHIP_ID, this.workerId, leaseId, t, t, expiresAt, t, t).changes;

      if (changes > 0) {
        this.localLeaseId = leaseId;
        this.localAcquiredAt = t;
        this.lastErr = null;
        await this.emit("ownership.acquired", { workerId: this.workerId, leaseId, expiresAt });
        try {
          await this.audit?.record({
            actor: this.workerId,
            action: "ci.reconciliation.ownership.acquired",
            resource_type: "ci_reconciliation_ownership",
            resource_id: CI_RECONCILIATION_OWNERSHIP_ID,
            result: "ok",
            metadata: { leaseId, expiresAt, ttlMs: this.ttlMs },
          });
        } catch { /* best-effort */ }
        return {
          owned: true,
          workerId: this.workerId,
          leaseId,
          holder: this.workerId,
          acquiredAt: t,
          renewedAt: t,
          expiresAt,
        };
      }

      this.localLeaseId = null;
      this.localAcquiredAt = null;
      return {
        owned: false,
        reason: "race-lost",
        workerId: this.workerId,
        leaseId: null,
        holder: null,
        acquiredAt: null,
        renewedAt: null,
        expiresAt: null,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      const isUnique = /UNIQUE/i.test(msg);
      if (!isUnique) this.lastErr = msg;
      this.localLeaseId = null;
      this.localAcquiredAt = null;
      await this.emit("ownership.not_acquired", {
        workerId: this.workerId, reason: isUnique ? "race-lost" : "db-error",
      });
      return {
        owned: false,
        reason: isUnique ? "race-lost" : "db-error",
        workerId: this.workerId,
        leaseId: null,
        holder: null,
        acquiredAt: null,
        renewedAt: null,
        expiresAt: null,
      };
    }
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.events?.emit({ type, source: SOURCE, payload });
    } catch { /* best-effort */ }
  }
}