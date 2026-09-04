export type RecoveryRiskClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export class WorkerRecoveryRisk {
  evaluate(actionRisk: number, blastRadiusRisk: number, uncertaintyRisk: number, sloRisk: number, consensusRisk: number): { score: number; riskClass: RecoveryRiskClass; confidence: number } {
    if (![actionRisk, blastRadiusRisk, uncertaintyRisk, sloRisk, consensusRisk].every(Number.isFinite)) return { score: 0, riskClass: "UNKNOWN", confidence: 0 };
    const score = Math.max(0, Math.min(1, actionRisk * 0.3 + blastRadiusRisk * 0.25 + uncertaintyRisk * 0.15 + sloRisk * 0.2 + consensusRisk * 0.1));
    let riskClass: RecoveryRiskClass = "LOW";
    if (score > 0.75) riskClass = "CRITICAL";
    else if (score > 0.5) riskClass = "HIGH";
    else if (score > 0.25) riskClass = "MEDIUM";
    return { score, riskClass, confidence: score };
  }
}
