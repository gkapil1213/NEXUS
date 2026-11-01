import { EnvelopeHmacKeyProvider } from "./envelope-hmac-key-provider";
import { NexusEngine } from "./db";
import { WorkerEnvelopeStore, MessageEnvelope } from "./worker-envelope-store";
export class WorkerTransportSecurity {
  private seenMessageIds = new Set<string>();
  private seenSequences = new Map<string, number>();

  private envelopeStore?: WorkerEnvelopeStore;

  constructor(private db?: NexusEngine, private keyProvider?: EnvelopeHmacKeyProvider) {
    if (this.db) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worker_message_ids (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seen_at INTEGER NOT NULL
        );
      `);
      if (this.hasEnvelopeSchema()) {
        this.envelopeStore = new WorkerEnvelopeStore(this.db, this.keyProvider!);
      }
    }
  }

  /**
   * Phase 292: true iff the envelope table exists (from migration 179).
   */
  hasEnvelopeSchema(): boolean {
    if (!this.db || this.db.kind !== "sqlite") return false;
    try {
      const cols = this.db.prepare("PRAGMA table_info(worker_message_envelopes)").all() as Array<{ name: string }>;
      if (!cols || cols.length === 0) return false;
      const names = new Set(cols.map(c => c.name));
      return names.has("message_id") && names.has("message_type") && names.has("payload_json") && names.has("payload_sha256");
    } catch { return false; }
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
  acceptMessageDurable(
    messageId: string,
    sessionId: string,
    sequence?: number,
    envelope?: MessageEnvelope,
  ): boolean {
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
    // Phase 292 decision 1: persist envelope in the same transaction.
    // Caller must wrap this call in engine.transaction(...) â€” the transaction
    // is established by the gateway's runAccept closure.
    if (envelope && this.envelopeStore) {
      const envResult = this.envelopeStore.persist(envelope);
      if (!envResult.persisted) {
        // Roll back the messageId insert by throwing; caller's transaction
        // will ROLLBACK on the thrown error.
        throw new Error("envelope_persist_failed:" + envResult.reason);
      }
    }
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



