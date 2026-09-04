import { WorkerFleetStore } from "./worker-fleet";

export type ScalingAction = "SCALE_OUT" | "HOLD" | "SCALE_IN" | "BLOCK_SCALE_IN" | "COOLDOWN";

export interface AutoscalingDecision {
  action: ScalingAction;
  reason: string;
  currentWorkers: number;
  targetWorkers: number;
  cooldownUntil?: number;
}

export interface AutoscalerConfig {
  minWorkers: number;
  maxWorkers: number;
  maxScaleStep: number;
  cooldownMs: number;
  queueDepthScaleOut: number;
  utilizationScaleOut: number;
  idleUtilizationScaleIn: number;
}

export class WorkerAutoscaler {
  private lastScaleDecisionAt: number = 0;

  constructor(private fleet: WorkerFleetStore, private config: AutoscalerConfig) {}

  evaluate(queueDepth: number, utilization: number, healthyWorkers: number): AutoscalingDecision {
    const now = Date.now();
    const cooldownRemaining = this.lastScaleDecisionAt + this.config.cooldownMs - now;
    if (cooldownRemaining > 0) {
      return {
        action: "COOLDOWN",
        reason: "cooldown_active",
        currentWorkers: healthyWorkers,
        targetWorkers: healthyWorkers,
        cooldownUntil: this.lastScaleDecisionAt + this.config.cooldownMs,
      };
    }

    if (queueDepth >= this.config.queueDepthScaleOut || utilization >= this.config.utilizationScaleOut) {
      if (healthyWorkers < this.config.maxWorkers) {
        const step = Math.min(this.config.maxScaleStep, this.config.maxWorkers - healthyWorkers);
        if (step > 0) {
          this.lastScaleDecisionAt = now;
          return { action: "SCALE_OUT", reason: "high_queue_or_utilization", currentWorkers: healthyWorkers, targetWorkers: healthyWorkers + step };
        }
      }
    }

    if (utilization <= this.config.idleUtilizationScaleIn && queueDepth === 0) {
      if (healthyWorkers > this.config.minWorkers) {
        const step = Math.min(1, healthyWorkers - this.config.minWorkers);
        if (step > 0) {
          this.lastScaleDecisionAt = now;
          return { action: "SCALE_IN", reason: "low_utilization", currentWorkers: healthyWorkers, targetWorkers: healthyWorkers - step };
        }
      }
    }

    return { action: "HOLD", reason: "stable", currentWorkers: healthyWorkers, targetWorkers: healthyWorkers };
  }
}
