import Database from "better-sqlite3";
import { WorkerFleetStore } from "./worker-fleet";
import { WorkerCapacityService } from "./worker-capacity";
import { RemoteWorkerStore } from "./remote-worker-store";
import { WorkerHealthStore } from "./worker-health";
import { WorkerTrustStore } from "./worker-trust";

export interface GlobalFleetSnapshot {
  totalWorkers: number;
  healthyWorkers: number;
  activeJobs: number;
  availableConcurrency: number;
  totalConcurrency: number;
  queueDepth: number;
  unhealthyWorkers: number;
  quarantinedWorkers: number;
  revokedWorkers: number;
  drainingWorkers: number;
  maintenanceWorkers: number;
  observedAt: number;
}

export class WorkerGlobalState {
  constructor(
    private db: Database.Database,
    private fleet: WorkerFleetStore,
    private capacity: WorkerCapacityService,
    private remoteWorkers: RemoteWorkerStore,
    private health: WorkerHealthStore,
    private trust: WorkerTrustStore
  ) {}

  capture(now: number = Date.now()): GlobalFleetSnapshot {
    const workers = this.fleet.listWorkers();
    const totalWorkers = workers.length;
    let healthyWorkers = 0;
    let activeJobs = 0;
    let totalConcurrency = 0;
    let queueDepth = 0;
    let unhealthyWorkers = 0;
    let quarantinedWorkers = 0;
    let revokedWorkers = 0;
    let drainingWorkers = 0;
    let maintenanceWorkers = 0;

    for (const worker of workers) {
      totalConcurrency += worker.concurrencyLimit ?? 0;
      activeJobs += worker.activeJobs;
      queueDepth += worker.queuedJobs;
      if (worker.draining) drainingWorkers++;
      if (worker.maintenance) maintenanceWorkers++;

      const trustRecord = this.trust.getTrust(worker.workerId);
      if (trustRecord?.trustState === "REVOKED") { revokedWorkers++; continue; }
      if (trustRecord?.trustState === "QUARANTINED") { quarantinedWorkers++; continue; }

      const healthSnap = this.health.getHealth(worker.workerId);
      if (!healthSnap || healthSnap.healthState !== "HEALTHY") { unhealthyWorkers++; continue; }

      healthyWorkers++;
    }

    const availableConcurrency = totalConcurrency - activeJobs;

    return {
      totalWorkers,
      healthyWorkers,
      activeJobs,
      availableConcurrency,
      totalConcurrency,
      queueDepth,
      unhealthyWorkers,
      quarantinedWorkers,
      revokedWorkers,
      drainingWorkers,
      maintenanceWorkers,
      observedAt: now,
    };
  }

  persist(snapshot: GlobalFleetSnapshot): void {
    this.db.prepare(`
      INSERT INTO worker_global_state (state_id, snapshot, created_at) VALUES (?, ?, ?)
    `).run(
      `gstate_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      JSON.stringify(snapshot),
      Date.now()
    );
  }
}
