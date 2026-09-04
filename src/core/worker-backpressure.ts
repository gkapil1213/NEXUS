export type BackpressureState = "NORMAL" | "ELEVATED" | "HIGH" | "CRITICAL";

export interface BackpressureConfig {
  queueDepthNormal: number;
  queueDepthElevated: number;
  queueDepthHigh: number;
  utilizationNormal: number;
  utilizationElevated: number;
  utilizationHigh: number;
}

export class WorkerBackpressureEngine {
  constructor(private config: BackpressureConfig) {}

  evaluate(queueDepth: number, utilization: number): BackpressureState {
    if (queueDepth >= this.config.queueDepthHigh || utilization >= this.config.utilizationHigh) {
      return "CRITICAL";
    }
    if (queueDepth >= this.config.queueDepthElevated || utilization >= this.config.utilizationElevated) {
      return "HIGH";
    }
    if (queueDepth >= this.config.queueDepthNormal || utilization >= this.config.utilizationNormal) {
      return "ELEVATED";
    }
    return "NORMAL";
  }
}
