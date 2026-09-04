import Database from "better-sqlite3";

export interface WorkerFleetState {
  workerId: string;
  region?: string;
  environment?: string;
  os?: string;
  architecture?: string;
  runtimeVersion?: string;
  labels?: Record<string, string>;
  cpuCapacity?: number;
  memoryCapacity?: number;
  diskCapacity?: number;
  concurrencyLimit?: number;
  activeJobs: number;
  queuedJobs: number;
  draining: boolean;
  maintenance: boolean;
  lastHeartbeatAt?: number;
  lastSeenAt?: number;
  lastJobAt?: number;
  failureCount: number;
  successCount: number;
  createdAt: number;
  updatedAt: number;
}

export class WorkerFleetStore {
  constructor(private db: Database.Database) {}

  upsert(state: WorkerFleetState): void {
    this.db.prepare(`
      INSERT INTO worker_fleet_state (
        worker_id, region, environment, os, architecture, runtime_version,
        labels, cpu_capacity, memory_capacity, disk_capacity, concurrency_limit,
        active_jobs, queued_jobs, draining, maintenance, last_heartbeat_at,
        last_seen_at, last_job_at, failure_count, success_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        region = excluded.region,
        environment = excluded.environment,
        os = excluded.os,
        architecture = excluded.architecture,
        runtime_version = excluded.runtime_version,
        labels = excluded.labels,
        cpu_capacity = excluded.cpu_capacity,
        memory_capacity = excluded.memory_capacity,
        disk_capacity = excluded.disk_capacity,
        concurrency_limit = excluded.concurrency_limit,
        active_jobs = excluded.active_jobs,
        queued_jobs = excluded.queued_jobs,
        draining = excluded.draining,
        maintenance = excluded.maintenance,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_seen_at = excluded.last_seen_at,
        last_job_at = excluded.last_job_at,
        failure_count = excluded.failure_count,
        success_count = excluded.success_count,
        updated_at = excluded.updated_at
    `).run(
      state.workerId,
      state.region,
      state.environment,
      state.os,
      state.architecture,
      state.runtimeVersion,
      state.labels ? JSON.stringify(state.labels) : null,
      state.cpuCapacity,
      state.memoryCapacity,
      state.diskCapacity,
      state.concurrencyLimit,
      state.activeJobs,
      state.queuedJobs,
      state.draining ? 1 : 0,
      state.maintenance ? 1 : 0,
      state.lastHeartbeatAt,
      state.lastSeenAt,
      state.lastJobAt,
      state.failureCount,
      state.successCount,
      state.createdAt,
      state.updatedAt
    );
  }

  getWorkerState(workerId: string): WorkerFleetState | undefined {
    const row = this.db.prepare("SELECT * FROM worker_fleet_state WHERE worker_id = ?").get(workerId);
    return row ? this.map(row) : undefined;
  }

  listWorkers(): WorkerFleetState[] {
    return this.db.prepare("SELECT * FROM worker_fleet_state").all().map(this.map);
  }

  getHealthyWorkerCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM worker_fleet_state
      WHERE draining = 0 AND maintenance = 0 AND active_jobs < concurrency_limit
    `).get() as any;
    return row?.count ?? 0;
  }

  getUtilization(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(active_jobs),0) as used, COALESCE(SUM(concurrency_limit),0) as total
      FROM worker_fleet_state
    `).get() as any;
    if (!row || row.total === 0) return 0;
    return row.used / row.total;
  }

  private map(row: any): WorkerFleetState {
    return {
      workerId: row.worker_id,
      region: row.region,
      environment: row.environment,
      os: row.os,
      architecture: row.architecture,
      runtimeVersion: row.runtime_version,
      labels: row.labels ? JSON.parse(row.labels) : undefined,
      cpuCapacity: row.cpu_capacity,
      memoryCapacity: row.memory_capacity,
      diskCapacity: row.disk_capacity,
      concurrencyLimit: row.concurrency_limit,
      activeJobs: row.active_jobs,
      queuedJobs: row.queued_jobs,
      draining: !!row.draining,
      maintenance: !!row.maintenance,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastSeenAt: row.last_seen_at,
      lastJobAt: row.last_job_at,
      failureCount: row.failure_count,
      successCount: row.success_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
