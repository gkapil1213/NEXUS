import { CapacityState } from "./worker-capacity-intelligence";
import { CapacityTrend } from "./worker-capacity-forecast";


export type ScalingStrategy = "NO_ACTION" | "SCALE_UP" | "SCALE_DOWN" | "HOLD" | "DEFER";

export class WorkerScalingStrategy {
  decide(state: CapacityState, trend: CapacityTrend, gap: number, risk: string, confidence: number): ScalingStrategy {
    if (confidence < 0.5 || state === "UNKNOWN" || trend === "UNKNOWN") return "DEFER";
    if (risk === "CRITICAL" || state === "SATURATED" || gap > 0) return "SCALE_UP";
    if (state === "OVER_CAPACITY" && trend === "DECREASING") return "SCALE_DOWN";
    if (state === "HEALTHY" && trend === "STABLE") return "NO_ACTION";
    return "HOLD";
  }
}
