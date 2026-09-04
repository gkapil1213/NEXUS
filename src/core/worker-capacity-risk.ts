import { WorkerPredictiveCapacity } from "./worker-predictive-capacity";

export type CapacityRiskLevel = "NORMAL" | "WATCH" | "ELEVATED" | "HIGH" | "CRITICAL" | "INSUFFICIENT_DATA";

export class WorkerCapacityRisk {
  evaluate(capacityForecast: { cpuDeficit: number; memoryDeficit: number; diskDeficit: number; concurrencyDeficit: number; dataSufficiency: string }): CapacityRiskLevel {
    if (capacityForecast.dataSufficiency === "INSUFFICIENT") return "INSUFFICIENT_DATA";
    const totalDeficit = capacityForecast.cpuDeficit + capacityForecast.memoryDeficit + capacityForecast.diskDeficit + capacityForecast.concurrencyDeficit;
    if (totalDeficit <= 0) return "NORMAL";
    if (totalDeficit < 5) return "WATCH";
    if (totalDeficit < 10) return "ELEVATED";
    if (totalDeficit < 20) return "HIGH";
    return "CRITICAL";
  }
}
