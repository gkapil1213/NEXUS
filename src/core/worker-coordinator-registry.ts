import Database from "better-sqlite3";

export type CoordinatorState = "ACTIVE" | "CANDIDATE" | "FOLLOWER" | "DRAINING" | "FAILED" | "FENCED" | "RECOVERING";

export interface CoordinatorRecord {
  coordinatorId: string;
  state: CoordinatorState;
  region?: string;
  zone?: string;
  environment?: string;
  lastHeartbeatAt?: number;
  currentEpoch?: string;
  createdAt: number;
  updatedAt: number;
}

export class CoordinatorRegistry {
  constructor(private db: Database.Database) {}

  register(record: CoordinatorRecord): void {
    this.db.prepare(`
      INSERT INTO coordinator_registry (
        coordinator_id, state, region, zone, environment,
        last_heartbeat_at, current_epoch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coordinator_id) DO UPDATE SET
        state = excluded.state,
        last_heartbeat_at = excluded.last_heartbeat_at,
        current_epoch = excluded.current_epoch,
        updated_at = excluded.updated_at
    `).run(
      record.coordinatorId,
      record.state,
      record.region,
      record.zone,
      record.environment,
      record.lastHeartbeatAt,
      record.currentEpoch,
      record.createdAt,
      record.updatedAt
    );
  }

  heartbeat(coordinatorId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE coordinator_registry SET last_heartbeat_at = ?, updated_at = ? WHERE coordinator_id = ?").run(now, now, coordinatorId);
  }

  get(coordinatorId: string): CoordinatorRecord | undefined {
    const row = this.db.prepare("SELECT * FROM coordinator_registry WHERE coordinator_id = ?").get(coordinatorId);
    return row ? this.map(row) : undefined;
  }

  listActive(now: number = Date.now(), timeoutMs: number = 30000): CoordinatorRecord[] {
    const rows = this.db.prepare("SELECT * FROM coordinator_registry WHERE state IN ('ACTIVE','CANDIDATE','FOLLOWER')").all() as any[];
    return rows.filter(row => (row.last_heartbeat_at ?? 0) + timeoutMs >= now).map(this.map);
  }

  updateState(coordinatorId: string, state: CoordinatorState): void {
    this.db.prepare("UPDATE coordinator_registry SET state = ?, updated_at = ? WHERE coordinator_id = ?").run(state, Date.now(), coordinatorId);
  }

  updateEpoch(coordinatorId: string, epochId: string): void {
    this.db.prepare("UPDATE coordinator_registry SET current_epoch = ?, updated_at = ? WHERE coordinator_id = ?").run(epochId, Date.now(), coordinatorId);
  }

  private map(row: any): CoordinatorRecord {
    return {
      coordinatorId: row.coordinator_id,
      state: row.state,
      region: row.region,
      zone: row.zone,
      environment: row.environment,
      lastHeartbeatAt: row.last_heartbeat_at,
      currentEpoch: row.current_epoch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
