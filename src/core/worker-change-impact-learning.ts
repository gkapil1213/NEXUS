export type ChangeImpactLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export class WorkerChangeImpactLearning {
  evaluate(changeType: string, previousOutcomes: { changeType: string; impactLevel: ChangeImpactLevel; confidence: number }[], confidence: number): { impactLevel: ChangeImpactLevel; confidence: number; evidence: string } {
    if (confidence < 0.5 || previousOutcomes.length < 3) return { impactLevel: "UNKNOWN", confidence, evidence: "insufficient_history" };
    const relevant = previousOutcomes.filter(o => o.changeType === changeType);
    if (relevant.length < 3) return { impactLevel: "UNKNOWN", confidence, evidence: "insufficient_relevant_history" };
    const levels = relevant.map(o => o.impactLevel);
    const worst = levels.sort((a, b) => this.rank(b) - this.rank(a))[0];
    return { impactLevel: worst, confidence: Math.min(confidence, 0.9), evidence: `based_on_${relevant.length}_outcomes` };
  }

  private rank(level: ChangeImpactLevel): number {
    const order = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];
    return order.indexOf(level);
  }
}
