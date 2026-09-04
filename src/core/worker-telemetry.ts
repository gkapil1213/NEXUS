import Database from "better-sqlite3";

export type TelemetryEventType =
  | "WORKER_REGISTERED"
  | "WORKER_AUTHENTICATED"
  | "WORKER_CONNECTED"
  | "WORKER_DISCONNECTED"
  | "WORKER_RECONNECTED"
  | "HEARTBEAT_RECEIVED"
  | "HEARTBEAT_MISSED"
  | "HEALTH_CHANGED"
  | "SESSION_CREATED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "LEASE_ACQUIRED"
  | "LEASE_RENEWED"
  | "LEASE_EXPIRED"
  | "LEASE_RELEASED"
  | "JOB_DISPATCHED"
  | "JOB_ACCEPTED"
  | "JOB_STARTED"
  | "JOB_COMPLETED"
  | "JOB_FAILED"
  | "JOB_CANCELLED"
  | "JOB_TIMED_OUT"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_FAILED"
  | "ARTIFACT_CREATED"
  | "ARTIFACT_VERIFIED"
  | "ARTIFACT_REJECTED"
  | "RESULT_CREATED"
  | "RESULT_VERIFIED"
  | "RESULT_REJECTED"
  | "RESULT_DUPLICATE"
  | "RESULT_REPLAY_REJECTED"
  | "RECOVERY_STARTED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_FAILED"
  | "SECURITY_VIOLATION"
  | "AUTH_FAILURE"
  | "REPLAY_DETECTED"
  | "SEQUENCE_VIOLATION"
  | "LEASE_HIJACK_ATTEMPT"
  | "TRUST_CHANGED"
  | "WORKER_QUARANTINED"
  | "WORKER_REVOKED"
  | "CREDENTIAL_CREATED"
  | "CREDENTIAL_ROTATED"
  | "CREDENTIAL_REVOKED"
  | "CREDENTIAL_EXPIRED";

export interface TelemetryEvent {
  eventId: string;
  eventType: TelemetryEventType;
  timestamp: number;
  workerId: string;
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

export class WorkerTelemetryStore {
  constructor(private db: Database.Database) {}

  persist(event: TelemetryEvent): void {
    this.db.prepare(`
      INSERT INTO worker_telemetry_events (
        event_id, event_type, timestamp, worker_id, session_id, job_id, attempt_id,
        dispatch_id, lease_id, credential_id, artifact_id, result_id, recovery_id,
        correlation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      event.payload ? JSON.stringify(event.payload) : null,
      Date.now()
    );
  }

  query(filter: {
    workerId?: string;
    eventType?: string;
    jobId?: string;
    attemptId?: string;
    sessionId?: string;
    leaseId?: string;
    correlationId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }): TelemetryEvent[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filter.workerId) { conditions.push("worker_id = ?"); params.push(filter.workerId); }
    if (filter.eventType) { conditions.push("event_type = ?"); params.push(filter.eventType); }
    if (filter.jobId) { conditions.push("job_id = ?"); params.push(filter.jobId); }
    if (filter.attemptId) { conditions.push("attempt_id = ?"); params.push(filter.attemptId); }
    if (filter.sessionId) { conditions.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.leaseId) { conditions.push("lease_id = ?"); params.push(filter.leaseId); }
    if (filter.correlationId) { conditions.push("correlation_id = ?"); params.push(filter.correlationId); }
    if (filter.startTime) { conditions.push("timestamp >= ?"); params.push(filter.startTime); }
    if (filter.endTime) { conditions.push("timestamp <= ?"); params.push(filter.endTime); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT * FROM worker_telemetry_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return rows.map((row: any) => this.mapEvent(row));
  }

  private mapEvent(row: any): TelemetryEvent {
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
    };
  }
}
