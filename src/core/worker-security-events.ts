import Database from "better-sqlite3";

export interface WorkerSecurityEvent {
  eventId: string;
  workerId: string;
  sessionId?: string;
  jobId?: string;
  attemptId?: string;
  dispatchId?: string;
  leaseId?: string;
  eventType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason?: string;
  evidence?: any;
  createdAt: number;
}

export class WorkerSecurityEventStore {
  constructor(private db: Database.Database) {}

  recordEvent(event: WorkerSecurityEvent): void {
    this.db.prepare(`
      INSERT INTO worker_security_events (
        event_id, worker_id, session_id, job_id, attempt_id, dispatch_id, lease_id,
        event_type, severity, reason, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.workerId,
      event.sessionId,
      event.jobId,
      event.attemptId,
      event.dispatchId,
      event.leaseId,
      event.eventType,
      event.severity,
      event.reason,
      event.evidence ? JSON.stringify(event.evidence) : null,
      event.createdAt
    );
  }

  listEventsForWorker(workerId: string): WorkerSecurityEvent[] {
    return this.db.prepare(
      "SELECT * FROM worker_security_events WHERE worker_id = ? ORDER BY created_at DESC"
    ).all(workerId).map((row: any) => this.mapEvent(row));
  }

  private mapEvent(row: any): WorkerSecurityEvent {
    return {
      eventId: row.event_id,
      workerId: row.worker_id,
      sessionId: row.session_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      dispatchId: row.dispatch_id,
      leaseId: row.lease_id,
      eventType: row.event_type,
      severity: row.severity,
      reason: row.reason,
      evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
      createdAt: row.created_at,
    };
  }
}
