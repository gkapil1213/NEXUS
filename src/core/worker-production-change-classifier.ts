export type ProductionChangeClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "INSUFFICIENT";

export interface ChangeClassificationInput {
  dependencyCount: number;
  changeType: string;
  securitySensitive: boolean;
  historicalFailures: number;
  affectedWorkers: number;
  confidence: number;
}

export class WorkerProductionChangeClassifier {
  classify(input: ChangeClassificationInput): ProductionChangeClass {
    if (!Number.isFinite(input.confidence) || input.confidence < 0.5) return "INSUFFICIENT";
    let score = 0;
    score += Math.min(input.dependencyCount * 0.15, 0.3);
    score += input.securitySensitive ? 0.3 : 0;
    score += Math.min(input.historicalFailures * 0.1, 0.2);
    score += input.affectedWorkers > 10 ? 0.3 : input.affectedWorkers > 3 ? 0.2 : input.affectedWorkers > 0 ? 0.05 : 0;
    score += input.changeType === "INFRASTRUCTURE_CHANGE" || input.changeType === "SCHEMA_MIGRATION" ? 0.2 : 0;
    if (score > 0.75) return "CRITICAL";
    if (score > 0.5) return "HIGH";
    if (score > 0.25) return "MEDIUM";
    return "LOW";
  }
}
