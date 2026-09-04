import { CapacityState } from "./worker-capacity-intelligence";

export class WorkerCapacityGap {
  calculate(currentCapacity: number, requiredCapacity: number, capacityState: CapacityState, forecastDemand?: number): { gap: number; headroom: number; risk: string; confidence: number } {
    if (!Number.isFinite(currentCapacity) || !Number.isFinite(requiredCapacity) || currentCapacity < 0 || requiredCapacity < 0) {
      return { gap: 0, headroom: 0, risk: "UNKNOWN", confidence: 0 };
    }
    const gap = requiredCapacity - currentCapacity;
    const headroom = currentCapacity - requiredCapacity;
    if (capacityState === "UNKNOWN") return { gap, headroom, risk: "UNKNOWN", confidence: 0.3 };
    let risk = "LOW";
    if (gap > 0) risk = gap / Math.max(currentCapacity, 1) > 0.3 ? "HIGH" : "MEDIUM";
    if (capacityState === "SATURATED") risk = "CRITICAL";
    const confidence = 0.8;
    return { gap, headroom, risk, confidence };
  }
}
