export class WorkerBlastRadius {
  calculate(affectedWorkers: number, totalWorkers: number, resourceImpact: number, scope: "local" | "fleet" | "global"): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
    if (scope === "global" && affectedWorkers > 0) return "CRITICAL";
    if (totalWorkers === 0) return "LOW";
    const ratio = affectedWorkers / totalWorkers;
    if (ratio > 0.4 || resourceImpact > 100) return "HIGH";
    if (ratio > 0.15 || resourceImpact > 50) return "MEDIUM";
    return "LOW";
  }
}
