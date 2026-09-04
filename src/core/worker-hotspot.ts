import Database from "better-sqlite3";
import { WorkerFleetStore } from "./worker-fleet";

export type HotspotState = "NORMAL" | "WATCH" | "HOT" | "CRITICAL";

export class WorkerHotspot {
  constructor(private db: Database.Database, private fleet: WorkerFleetStore) {}

  evaluate(workerId: string): { state: HotspotState; reason: string } {
    const worker = this.fleet.getWorkerState(workerId);
    if (!worker) return { state: "NORMAL", reason: "worker_not_found" };

    const limit = worker.concurrencyLimit ?? 1;
    const utilization = limit === 0 ? 0 : worker.activeJobs / limit;
    const all = this.fleet.listWorkers();
    const totalUtil = all.reduce((sum, w) => sum + (w.concurrencyLimit ? w.activeJobs / w.concurrencyLimit : 0), 0);
    const avgUtil = all.length === 0 ? 0 : totalUtil / all.length;

    if (utilization >= 0.95 || (utilization > 0.8 && utilization > avgUtil * 1.5)) {
      return { state: "CRITICAL", reason: "severe_overload" };
    }
    if (utilization > 0.7 || utilization > avgUtil * 1.3) {
      return { state: "HOT", reason: "above_average_load" };
    }
    if (utilization > 0.5 && utilization > avgUtil * 1.1) {
      return { state: "WATCH", reason: "moderate_load" };
    }
    return { state: "NORMAL", reason: "load_within_range" };
  }

  persist(workerId: string, state: HotspotState, reason: string): void {
    this.db.prepare(`
      INSERT INTO worker_hotspots (hotspot_id, worker_id, state, evidence, detected_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `hot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      workerId,
      state,
      JSON.stringify({ reason }),
      Date.now()
    );
  }
}
