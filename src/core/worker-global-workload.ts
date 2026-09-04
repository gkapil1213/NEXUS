import Database from "better-sqlite3";
import { WorkerFleetStore } from "./worker-fleet";

export interface WorkloadObservation {
  observationId: string;
  windowStart: number;
  windowEnd: number;
  queueDepth: number;
  jobsCreated: number;
  jobsAdmitted: number;
  jobsDeferred: number;
  jobsRejected: number;
  jobsCompleted: number;
  jobsFailed: number;
  cpuDemand: number;
  memoryDemand: number;
  diskDemand: number;
  concurrencyDemand: number;
  dataQuality: "FRESH" | "DEGRADED" | "STALE" | "INVALID" | "INSUFFICIENT";
}

export class GlobalWorkloadObserver {
  constructor(private db: Database.Database, private fleet: WorkerFleetStore) {}

  observe(windowStart: number = Date.now() - 60000, windowEnd: number = Date.now()): WorkloadObservation {
    const fleetState = this.fleet.listWorkers();
    let queueDepth = 0;
    let activeJobs = 0;
    let cpuDemand = 0;
    let memoryDemand = 0;
    let diskDemand = 0;
    let concurrencyDemand = 0;
    for (const w of fleetState) {
      queueDepth += w.queuedJobs;
      activeJobs += w.activeJobs;
      cpuDemand += w.cpuCapacity ?? 0;
      memoryDemand += w.memoryCapacity ?? 0;
      diskDemand += w.diskCapacity ?? 0;
      concurrencyDemand += w.concurrencyLimit ?? 0;
    }

    const jobsCreated = (this.db.prepare("SELECT COUNT(*) as c FROM execution_jobs WHERE created_at >= ? AND created_at <= ?").get(windowStart, windowEnd) as any)?.c ?? 0;
    const jobsFailed = (this.db.prepare("SELECT COUNT(*) as c FROM execution_jobs WHERE status = 'FAILED' AND updated_at >= ? AND updated_at <= ?").get(windowStart, windowEnd) as any)?.c ?? 0;

    const observation: WorkloadObservation = {
      observationId: `obs_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      windowStart,
      windowEnd,
      queueDepth,
      jobsCreated,
      jobsAdmitted: activeJobs,
      jobsDeferred: queueDepth,
      jobsRejected: 0,
      jobsCompleted: 0,
      jobsFailed,
      cpuDemand,
      memoryDemand,
      diskDemand,
      concurrencyDemand,
      dataQuality: "FRESH",
    };

    this.persist(observation);
    return observation;
  }

  persist(obs: WorkloadObservation): void {
    this.db.prepare(`
      INSERT INTO worker_workload_observations (
        observation_id, window_start, window_end, queue_depth, jobs_created,
        jobs_admitted, jobs_deferred, jobs_rejected, jobs_completed, jobs_failed,
        cpu_demand, memory_demand, disk_demand, concurrency_demand, data_quality, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obs.observationId,
      obs.windowStart,
      obs.windowEnd,
      obs.queueDepth,
      obs.jobsCreated,
      obs.jobsAdmitted,
      obs.jobsDeferred,
      obs.jobsRejected,
      obs.jobsCompleted,
      obs.jobsFailed,
      obs.cpuDemand,
      obs.memoryDemand,
      obs.diskDemand,
      obs.concurrencyDemand,
      obs.dataQuality,
      Date.now()
    );
  }
}
