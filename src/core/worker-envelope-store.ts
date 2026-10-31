// Phase 292: durable message envelope persistence.
// Stores payload + routing metadata required for safe recovery replay.
// Per design decision 1: envelope is persisted in the same transaction as
// acceptance (caller must use engine.transaction to wrap both writes).

import { NexusEngine } from "./db";
import { createHash } from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface MessageEnvelope {
  messageId: string;
  messageType: string;
  workerId: string;
  sessionId: string;
  payload: unknown;
  envelopeVersion: number;
  acceptedAt: number;
}

export interface PersistedEnvelope extends MessageEnvelope {
  payloadSha256: string;
}

export interface EnvelopePersistResult {
  persisted: boolean;
  reason?: "envelope_schema_absent" | "payload_too_large" | "duplicate_message_id" | "invalid_payload" | "persistence_error";
  payloadSha256?: string;
}

export class WorkerEnvelopeStore {
  constructor(private db: NexusEngine) {}

  hasEnvelopeSchema(): boolean {
    if (!this.db || this.db.kind !== "sqlite") return false;
    try {
      const cols = this.db.prepare("PRAGMA table_info(worker_message_envelopes)").all() as Array<{ name: string }>;
      if (!cols || cols.length === 0) return false;
      const names = new Set(cols.map(c => c.name));
      return names.has("message_id") && names.has("message_type") && names.has("payload_json") && names.has("payload_sha256") && names.has("envelope_version");
    } catch { return false; }
  }

  persist(envelope: MessageEnvelope): EnvelopePersistResult {
    if (!this.hasEnvelopeSchema()) return { persisted: false, reason: "envelope_schema_absent" };
    if (envelope.envelopeVersion !== ENVELOPE_VERSION) return { persisted: false, reason: "invalid_payload" };
    let payloadJson: string;
    try { payloadJson = JSON.stringify(envelope.payload ?? null); }
    catch { return { persisted: false, reason: "invalid_payload" }; }
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) return { persisted: false, reason: "payload_too_large" };
    const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
    try {
      const result = this.db.prepare(`INSERT INTO worker_message_envelopes (message_id, message_type, worker_id, session_id, payload_json, payload_sha256, envelope_version, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        envelope.messageId, envelope.messageType, envelope.workerId, envelope.sessionId,
        payloadJson, payloadSha256, envelope.envelopeVersion, envelope.acceptedAt
      );
      if (result.changes !== 1) return { persisted: false, reason: "duplicate_message_id" };
      return { persisted: true, payloadSha256 };
    } catch (e: any) {
      if (/UNIQUE constraint failed/i.test(String(e?.message ?? e))) return { persisted: false, reason: "duplicate_message_id" };
      return { persisted: false, reason: "persistence_error" };
    }
  }

  load(messageId: string): PersistedEnvelope | undefined {
    if (!this.hasEnvelopeSchema()) return undefined;
    const row = this.db.prepare(`SELECT message_id, message_type, worker_id, session_id, payload_json, payload_sha256, envelope_version, accepted_at FROM worker_message_envelopes WHERE message_id = ?`).get(messageId) as any;
    if (!row) return undefined;
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { return undefined; }
    return {
      messageId: row.message_id, messageType: row.message_type, workerId: row.worker_id,
      sessionId: row.session_id, payload, payloadSha256: row.payload_sha256,
      envelopeVersion: row.envelope_version, acceptedAt: row.accepted_at,
    };
  }

  verifyIntegrity(envelope: PersistedEnvelope): boolean {
    let payloadJson: string;
    try { payloadJson = JSON.stringify(envelope.payload ?? null); }
    catch { return false; }
    return createHash("sha256").update(payloadJson).digest("hex") === envelope.payloadSha256;
  }

  deleteEnvelope(messageId: string): boolean {
    if (!this.hasEnvelopeSchema()) return false;
    return this.db.prepare("DELETE FROM worker_message_envelopes WHERE message_id = ?").run(messageId).changes === 1;
  }
}