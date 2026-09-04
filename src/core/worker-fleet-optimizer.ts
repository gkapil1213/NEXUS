import { WorkerFleetStore } from "./worker-fleet";
import { WorkerResiliencePolicy, ResilienceState } from "./worker-resilience-policy";
import { WorkerHotspot } from "./worker-hotspot";
import { WorkerCapacityPlanner } from "./worker-capacity-planner";

export type OptimizationAction =
  | "OPTIMIZE_NONE"
  | "REBALANCE"
  | "PREFER_WORKER"
  | "AVOID_WORKER"
  | "DRAIN_WORKER"
  | "REQUEST_SCALE_OUT"
  | "REQUEST_SCALE_IN"
  | "HOLD"
  | "BLOCKED";

export interface OptimizationDecision {
  action: OptimizationAction;
  reason: string;
  affectedWorkerId?: string;
  evidence: Record<string, any>;
}

export class WorkerFleetOptimizer {
  constructor(
    private fleet: WorkerFleetStore,
    private resilience: WorkerResiliencePolicy,
    private hotspot: WorkerHotspot,
    private capacityPlanner: WorkerCapacityPlanner
  ) {}

  evaluate(queueDepth: number, utilization: number): OptimizationDecision {
    const workers = this.fleet.listWorkers();
    const activeWorkers = workers.filter((w) => !w.draining && !w.maintenance);
    const totalWorkers = activeWorkers.length;
    const unhealthyCount = workers.filter((w) => w.maintenance || w.draining).length; // simplified

    const resilienceState = this.resilience.evaluate({
      unhealthyWorkerPercent: totalWorkers === 0 ? 0 : unhealthyCount / totalWorkers,
      staleWorkerPercent: 0,
      failureRate: 0,
      hotspotCount: 0,
      queueDepth,
    });

    // Check for hotspots among active workers
    for (const worker of activeWorkers) {
      const hotspotState = this.hotspot.evaluate(worker.workerId);
      if (hotspotState.state === "CRITICAL" || hotspotState.state === "HOT") {
        return {
          action: "REBALANCE",
          reason: `worker_hotspot_${worker.workerId}`,
          affectedWorkerId: worker.workerId,
          evidence: { hotspotState: hotspotState.state, workerId: worker.workerId },
        };
      }
    }

    if (resilienceState === "CRITICAL") {
      return { action: "BLOCKED", reason: "critical_resilience", evidence: { resilienceState } };
    }

    if (queueDepth > 100 || utilization > 0.9) {
      return { action: "REQUEST_SCALE_OUT", reason: "high_pressure", evidence: { queueDepth, utilization } };
    }

    if (queueDepth === 0 && utilization < 0.2 && totalWorkers > 1) {
      return { action: "REQUEST_SCALE_IN", reason: "low_utilization", evidence: { utilization } };
    }

    return { action: "HOLD", reason: "stable", evidence: { queueDepth, utilization } };
  }
}
