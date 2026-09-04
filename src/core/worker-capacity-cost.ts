export class WorkerCapacityCost {
  evaluate(workerCount: number, utilization: number, scalingFrequency: number): "EFFICIENT" | "MODERATE" | "INEFFICIENT" | "UNKNOWN" {
    if (!Number.isFinite(workerCount) || !Number.isFinite(utilization) || !Number.isFinite(scalingFrequency)) return "UNKNOWN";
    if (utilization > 0.7 && scalingFrequency < 2) return "EFFICIENT";
    if (utilization > 0.5 && scalingFrequency < 4) return "MODERATE";
    return "INEFFICIENT";
  }
}
