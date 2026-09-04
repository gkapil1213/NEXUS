import Database from "better-sqlite3";

export type WorkerHealthState =
  | "HEALTHY"
  | "DEGRADED"
  | "STALE"
  | "DISCONNECTED"
  | "UNHEALTHY"
  | "RECOVERING"
  | "QUARANTINED"
  | "REVOKED";

export interface WorkerHealthSnapshot {
  workerId: string;
  healthState: WorkerHealthState;
  lastHeartbeatAt?: number;
  heartbeatFailures: number;
  lastJobId?: string;
  lastLeaseId?: string;
  detectedAt?: number;
  updatedAt: number;
}

export class WorkerHealthStore {
  constructor(private db: Database.Database) {}

  upsertHealth(snapshot: WorkerHealthSnapshot): void {
    this.db.prepare(`
      INSERT INTO worker_health (
        worker_id, health_state, last_heartbeat_at, heartbeat_failures,
        last_job_id, last_lease_id, detected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        health_state = excluded.health_state,
        last_heartbeat_at = excluded.last_heartbeat_at,
        heartbeat_failures = excluded.heartbeat_failures,
        last_job_id = excluded.last_job_id,
        last_lease_id = excluded.last_lease_id,
        detected_at = excluded.detected_at,
        updated_at = excluded.updated_at
    `).run(
      snapshot.workerId,
      snapshot.healthState,
      snapshot.lastHeartbeatAt,
      snapshot.heartbeatFailures,
      snapshot.lastJobId,
      snapshot.lastLeaseId,
      snapshot.detectedAt,
      snapshot.updatedAt
    );
  }

  getHealth(workerId: string): WorkerHealthSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM worker_health WHERE worker_id = ?").get(workerId);
    return row ? this.mapHealth(row) : undefined;
  }

  recordHealthEvent(event: { eventId: string; workerId: string; eventType: string; payload?: any; createdAt: number }): void {
    this.db.prepare(`
      INSERT INTO worker_health_events (event_id, worker_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.workerId,
      event.eventType,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt
    );
  }

  private mapHealth(row: any): WorkerHealthSnapshot {
    return {
      workerId: row.worker_id,
      healthState: row.health_state,
      lastHeartbeatAt: row.last_heartbeat_at,
      heartbeatFailures: row.heartbeat_failures,
      lastJobId: row.last_job_id,
      lastLeaseId: row.last_lease_id,
      detectedAt: row.detected_at,
      updatedAt: row.updated_at,
    };
  }
}
