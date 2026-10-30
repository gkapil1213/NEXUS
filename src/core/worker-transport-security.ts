import { NexusEngine } from "./db";

export class WorkerTransportSecurity {
  private seenMessageIds = new Set<string>();
  private seenSequences = new Map<string, number>();

  constructor(private db?: NexusEngine) {
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worker_message_ids (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seen_at INTEGER NOT NULL
        );
      `);
    }
  }

  /**
   * Phase 291: true only when the complete handler lifecycle schema exists.
   * Legacy/test databases created through SQLiteEngine.fromDatabase may not
   * have run migrations; those databases retain Phase 290 durable acceptance.
   */
  hasHandlerTrackingSchema(): boolean {
    if (!this.db || this.db.kind !== "sqlite") return false;
    const columns = this.db.prepare("PRAGMA table_info(worker_message_ids)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    return [
      "handler_status",
      "handler_owner_id",
      "handler_claim_expires_at",
      "handler_started_at",
      "handler_completed_at",
      "handler_attempt_count",
      "handler_last_error",
      "handler_recovery_reason",
    ].every((name) => names.has(name));
  }
  validateFreshMessage(messageId: string, sessionId: string, sequence?: number): { valid: boolean; reason?: string } {
    if (this.db) {
      const row = this.db.prepare("SELECT 1 FROM worker_message_ids WHERE message_id = ?").get(messageId);
      if (row) return { valid: false, reason: "duplicate_message" };
    } else if (this.seenMessageIds.has(messageId)) {
      return { valid: false, reason: "duplicate_message" };
    }

    if (sequence !== undefined) {
      const last = this.seenSequences.get(sessionId) ?? 0;
      if (sequence <= last) {
        return { valid: false, reason: "invalid_sequence" };
      }
    }
    return { valid: true };
  }

  /**
   * Phase 290: returns true iff this call inserted a fresh messageId.
   * Used inside the gateway's acceptance transaction (Design B, Strict B1).
   */
  acceptMessageDurable(messageId: string, sessionId: string, sequence?: number): boolean {
    if (!this.db) {
      if (this.seenMessageIds.has(messageId)) return false;
      this.seenMessageIds.add(messageId);
      if (sequence !== undefined) this.seenSequences.set(sessionId, sequence);
      return true;
    }
    const result = this.hasHandlerTrackingSchema()
      ? this.db.prepare(
          "INSERT OR IGNORE INTO worker_message_ids (message_id, session_id, seen_at, handler_status) VALUES (?, ?, ?, 'PENDING')"
        ).run(messageId, sessionId, Date.now())
      : this.db.prepare(
          "INSERT OR IGNORE INTO worker_message_ids (message_id, session_id, seen_at) VALUES (?, ?, ?)"
        ).run(messageId, sessionId, Date.now());
    if (result.changes !== 1) return false;
    if (sequence !== undefined) this.seenSequences.set(sessionId, sequence);
    return true;
  }

  acceptMessage(messageId: string, sessionId: string, sequence?: number): void {
    if (this.db) {
      this.db.prepare(
        "INSERT OR IGNORE INTO worker_message_ids (message_id, session_id, seen_at) VALUES (?, ?, ?)"
      ).run(messageId, sessionId, Date.now());
    } else {
      this.seenMessageIds.add(messageId);
    }
    if (sequence !== undefined) {
      this.seenSequences.set(sessionId, sequence);
    }
  }
}