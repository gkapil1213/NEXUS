import { WorkerFleetStore } from "./worker-fleet";
import { WorkerHotspot, HotspotState } from "./worker-hotspot";

export type RebalanceAction = "NO_ACTION" | "REBALANCE_RECOMMENDED" | "REBALANCE_REQUIRED" | "REBALANCE_BLOCKED";

export interface RebalanceDecision {
  action: RebalanceAction;
  reasons: string[];
}

export class WorkerRebalancer {
  constructor(private fleet: WorkerFleetStore, private hotspot: WorkerHotspot) {}

  evaluate(): RebalanceDecision {
    const reasons: string[] = [];
    const workers = this.fleet.listWorkers();
    const activeWorkers = workers.filter((w) => !w.draining && !w.maintenance);

    // Very simple heuristic: if any worker is CRITICAL hotspot, recommend rebalance
    for (const worker of activeWorkers) {
      const h = this.hotspot.evaluate(worker.workerId);
      if (h.state === "CRITICAL" || h.state === "HOT") {
        reasons.push(`${worker.workerId}:${h.state}`);
      }
    }

    if (reasons.length === 0) return { action: "NO_ACTION", reasons: [] };
    if (reasons.length === 1 && reasons[0].includes("HOT")) {
      return { action: "REBALANCE_RECOMMENDED", reasons };
    }
    return { action: "REBALANCE_REQUIRED", reasons };
  }
}
