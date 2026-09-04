export type ChangeRiskClass = "LOW" | "GUARDED" | "HIGH" | "CRITICAL";

export interface ChangeRiskInput {
  dependencyDepth: number;
  magnitude: number;
  confidence: number;
  reliabilityScore: number;
  sloState: string;
  errorBudgetState: string;
  activeIncidents: number;
  rollbackAvailable: boolean;
}

export class WorkerChangeRisk {
  evaluate(input: ChangeRiskInput): { riskClass: ChangeRiskClass; score: number; reasons: string[]; blocked: boolean } {
    if (!Number.isFinite(input.dependencyDepth) || !Number.isFinite(input.magnitude) || !Number.isFinite(input.confidence) || !Number.isFinite(input.reliabilityScore)) {
      return { riskClass: "CRITICAL", score: 1, reasons: ["invalid_or_insufficient_evidence"], blocked: true };
    }
    if (input.confidence < 0.5) return { riskClass: "CRITICAL", score: 1, reasons: ["low_confidence"], blocked: true };
    if (input.activeIncidents > 2 || input.sloState === "CRITICAL" || input.errorBudgetState === "CRITICAL") {
      return { riskClass: "CRITICAL", score: 1, reasons: ["active_production_risk"], blocked: true };
    }
    const score = Math.max(0, Math.min(1,
      input.dependencyDepth * 0.15 +
      input.magnitude * 0.2 +
      (1 - input.reliabilityScore) * 0.25 +
      (input.sloState === "BREACHING" ? 0.3 : 0) +
      (input.activeIncidents > 0 ? 0.2 : 0) +
      (input.rollbackAvailable ? 0 : 0.3)
    ));
    let riskClass: ChangeRiskClass = "LOW";
    if (score > 0.7) riskClass = "CRITICAL";
    else if (score > 0.5) riskClass = "HIGH";
    else if (score > 0.3) riskClass = "GUARDED";
    return { riskClass, score, reasons: [], blocked: riskClass === "CRITICAL" };
  }
}
