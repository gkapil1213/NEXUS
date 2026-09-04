export type ScalingRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export class WorkerScalingRisk {
  evaluate(affectedWorkers: number, dependencyCriticality: number, activeIncidents: number, sloState: string, rollbackAvailable: boolean, confidence: number): ScalingRisk {
    if (!Number.isFinite(confidence) || confidence < 0.5) return "UNKNOWN";
    let score = 0;
    score += Math.min(affectedWorkers * 0.03, 0.3);
    score += dependencyCriticality * 0.2;
    score += activeIncidents > 0 ? 0.3 : 0;
    if (sloState === "BREACHING") score += 0.2;
    if (sloState === "CRITICAL") score += 0.4;
    if (!rollbackAvailable) score += 0.3;
    score = Math.min(1, score);
    if (score > 0.9) return "CRITICAL";
    if (score > 0.55) return "HIGH";
    if (score > 0.1) return "MEDIUM";
    return "LOW";
  }
}
