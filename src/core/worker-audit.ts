import Database from "better-sqlite3";
import { sha256Hex, canonicalize } from "./integrity";
import { sanitizeTelemetryPayload } from "./worker-telemetry-sanitizer";

export interface AuditEvent {
  eventId: string;
  eventType: string;
  timestamp: number;
  workerId?: string;
  sessionId?: string;
  jobId?: string;
  attemptId?: string;
  dispatchId?: string;
  leaseId?: string;
  credentialId?: string;
  artifactId?: string;
  resultId?: string;
  recoveryId?: string;
  correlationId?: string;
  payload?: Record<string, any>;
}

export interface AuditEventRecord extends AuditEvent {
  previousEventHash?: string;
  eventHash: string;
}

export class WorkerAuditStore {
  constructor(private db: Database.Database) {}

  append(event: AuditEvent): AuditEventRecord {
    const lastRow = this.db.prepare(
      "SELECT event_hash FROM worker_audit_events ORDER BY rowid DESC LIMIT 1"
    ).get() as any;
    const lastHash = lastRow?.event_hash ?? null;

    const payload = event.payload ? sanitizeTelemetryPayload(event.payload) : undefined;
    const canonical = canonicalize({
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      workerId: event.workerId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      attemptId: event.attemptId,
      dispatchId: event.dispatchId,
      leaseId: event.leaseId,
      credentialId: event.credentialId,
      artifactId: event.artifactId,
      resultId: event.resultId,
      recoveryId: event.recoveryId,
      correlationId: event.correlationId,
      payload,
    });
    const eventHash = sha256Hex(canonical + (lastHash || ""));

    this.db.prepare(`
      INSERT INTO worker_audit_events (
        event_id, event_type, timestamp, worker_id, session_id, job_id, attempt_id,
        dispatch_id, lease_id, credential_id, artifact_id, result_id, recovery_id,
        correlation_id, payload, previous_event_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.eventType,
      event.timestamp,
      event.workerId,
      event.sessionId,
      event.jobId,
      event.attemptId,
      event.dispatchId,
      event.leaseId,
      event.credentialId,
      event.artifactId,
      event.resultId,
      event.recoveryId,
      event.correlationId,
      payload ? JSON.stringify(payload) : null,
      lastHash,
      eventHash,
      Date.now()
    );

    return {
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      workerId: event.workerId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      attemptId: event.attemptId,
      dispatchId: event.dispatchId,
      leaseId: event.leaseId,
      credentialId: event.credentialId,
      artifactId: event.artifactId,
      resultId: event.resultId,
      recoveryId: event.recoveryId,
      correlationId: event.correlationId,
      payload,
      previousEventHash: lastHash ?? undefined,
      eventHash,
    };
  }

  getEvent(eventId: string): AuditEventRecord | undefined {
    const row = this.db.prepare("SELECT * FROM worker_audit_events WHERE event_id = ?").get(eventId) as any;
    return row ? this.mapRecord(row) : undefined;
  }

  listEvents(filter: { workerId?: string; eventType?: string; startTime?: number; endTime?: number; limit?: number; offset?: number } = {}): AuditEventRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filter.workerId) { conditions.push("worker_id = ?"); params.push(filter.workerId); }
    if (filter.eventType) { conditions.push("event_type = ?"); params.push(filter.eventType); }
    if (filter.startTime) { conditions.push("timestamp >= ?"); params.push(filter.startTime); }
    if (filter.endTime) { conditions.push("timestamp <= ?"); params.push(filter.endTime); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const rows = this.db.prepare(`SELECT * FROM worker_audit_events ${where} ORDER BY rowid ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map((row: any) => this.mapRecord(row));
  }

  verifyChain(): { valid: boolean; invalidEvents: string[]; checkedEvents: number } {
    const rows = this.db.prepare("SELECT * FROM worker_audit_events ORDER BY rowid ASC").all() as any[];
    const invalid: string[] = [];
    let previousHash: string | null = null;
    for (const row of rows) {
      const payload = row.payload ? JSON.parse(row.payload) : undefined;
      const canonical = canonicalize({
        eventId: row.event_id,
        eventType: row.event_type,
        timestamp: row.timestamp,
        workerId: row.worker_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        jobId: row.job_id ?? undefined,
        attemptId: row.attempt_id ?? undefined,
        dispatchId: row.dispatch_id ?? undefined,
        leaseId: row.lease_id ?? undefined,
        credentialId: row.credential_id ?? undefined,
        artifactId: row.artifact_id ?? undefined,
        resultId: row.result_id ?? undefined,
        recoveryId: row.recovery_id ?? undefined,
        correlationId: row.correlation_id ?? undefined,
        payload,
      });
      const expectedHash = sha256Hex(canonical + (previousHash || ""));
      if ((row.previous_event_hash ?? null) !== previousHash || row.event_hash !== expectedHash) {
        invalid.push(row.event_id);
      }
      previousHash = row.event_hash;
    }
    return { valid: invalid.length === 0, invalidEvents: invalid, checkedEvents: rows.length };
  }

  private mapRecord(row: any): AuditEventRecord {
    return {
      eventId: row.event_id,
      eventType: row.event_type,
      timestamp: row.timestamp,
      workerId: row.worker_id,
      sessionId: row.session_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      dispatchId: row.dispatch_id,
      leaseId: row.lease_id,
      credentialId: row.credential_id,
      artifactId: row.artifact_id,
      resultId: row.result_id,
      recoveryId: row.recovery_id,
      correlationId: row.correlation_id,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      previousEventHash: row.previous_event_hash ?? undefined,
      eventHash: row.event_hash,
    };
  }
}
