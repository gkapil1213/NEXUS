import { WorkerFleetStore, WorkerFleetState } from "./worker-fleet";
import { WorkerHotspot } from "./worker-hotspot";

export interface DistributionRecommendation {
  action: "NO_ACTION" | "REBALANCE" | "PROTECT_WORKER";
  workerId?: string;
  reason: string;
}

export class WorkerWorkloadDistributor {
  constructor(private fleet: WorkerFleetStore, private hotspot: WorkerHotspot) {}

  evaluate(): DistributionRecommendation {
    const workers = this.fleet.listWorkers().filter((w) => !w.draining && !w.maintenance);
    if (workers.length === 0) return { action: "NO_ACTION", reason: "no_eligible_workers" };

    let maxUtil = -1;
    let hotWorkerId: string | undefined;
    for (const worker of workers) {
      const limit = worker.concurrencyLimit ?? 1;
      const util = limit === 0 ? 0 : worker.activeJobs / limit;
      if (util > maxUtil) {
        maxUtil = util;
        hotWorkerId = worker.workerId;
      }
    }

    if (hotWorkerId && maxUtil >= 0.8) {
      const h = this.hotspot.evaluate(hotWorkerId);
      if (h.state === "HOT" || h.state === "CRITICAL") {
        return { action: "REBALANCE", workerId: hotWorkerId, reason: `hot_worker_${hotWorkerId}` };
      }
    }

    return { action: "NO_ACTION", reason: "balanced_or_no_hotspot" };
  }
}
