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