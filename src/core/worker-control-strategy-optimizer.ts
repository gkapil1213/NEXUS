export type ProductionStrategy = "OBSERVE" | "HOLD" | "PAUSE" | "CANARY" | "SMALL_WAVE" | "PROGRESSIVE_WAVE" | "FULL_RELEASE" | "ROLLBACK" | "RECOVER" | "ESCALATE";

export class WorkerControlStrategyOptimizer {
  select(reliability: number, changeRisk: string, blastRadius: string, confidence: number): ProductionStrategy {
    if (confidence < 0.5) return "OBSERVE";
    if (reliability < 0.3 || changeRisk === "CRITICAL" || blastRadius === "CRITICAL") return "ROLLBACK";
    if (changeRisk === "HIGH" || blastRadius === "LARGE") return "CANARY";
    if (reliability < 0.7) return "HOLD";
    if (changeRisk === "GUARDED") return "PROGRESSIVE_WAVE";
    return "FULL_RELEASE";
  }
}
