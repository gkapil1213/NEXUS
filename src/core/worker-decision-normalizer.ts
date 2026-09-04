export interface DomainRecommendation {
  controller: string;
  action: string;
  target?: string;
  reason?: string;
  expectedBenefit?: string;
  reliabilityImpact: number;
  costImpact: number;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
  confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  urgency: number;
  reversibility: string;
  blastRadius: string;
}

export class WorkerDecisionNormalizer {
  normalize(rec: DomainRecommendation): DomainRecommendation {
    return {
      ...rec,
      action: rec.action.toUpperCase(),
      target: rec.target || "unknown",
      urgency: Math.max(0, Math.min(5, rec.urgency)),
      confidence: rec.confidence.toUpperCase() as any,
      risk: rec.risk.toUpperCase() as any,
    };
  }
}
