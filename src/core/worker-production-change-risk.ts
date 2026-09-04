export type ProductionChangeRiskClass = "LOW" | "GUARDED" | "HIGH" | "CRITICAL" | "INSUFFICIENT";

export interface ProductionChangeRiskInput {
  changeClass: string;
  reliabilityScore: number;
  sloState: string;
  errorBudgetState: string;
  activeIncidents: number;
  rollbackAvailable: boolean;
  confidence: number;
}

export class WorkerProductionChangeRisk {
  evaluate(input: ProductionChangeRiskInput): { riskClass: ProductionChangeRiskClass; score: number; reasons: string[] } {
    if (!Number.isFinite(input.confidence) || input.confidence < 0.5) return { riskClass: "INSUFFICIENT", score: 0, reasons: ["low_confidence"] };
    if (input.changeClass === "CRITICAL" || input.sloState === "CRITICAL" || input.errorBudgetState === "CRITICAL" || input.activeIncidents > 2) {
      return { riskClass: "CRITICAL", score: 1, reasons: ["critical_signal"] };
    }
    let score = 0;
    if (input.changeClass === "HIGH") score += 0.4;
    else if (input.changeClass === "MEDIUM") score += 0.25;
    score += (1 - input.reliabilityScore) * 0.3;
    if (input.sloState === "BREACHING") score += 0.25;
    if (!input.rollbackAvailable) score += 0.3;
    if (input.activeIncidents > 0) score += 0.2;
    score = Math.min(1, score);
    let riskClass: ProductionChangeRiskClass = "LOW";
    if (score > 0.7) riskClass = "CRITICAL";
    else if (score > 0.5) riskClass = "HIGH";
    else if (score > 0.3) riskClass = "GUARDED";
    return { riskClass, score, reasons: [] };
  }
}
