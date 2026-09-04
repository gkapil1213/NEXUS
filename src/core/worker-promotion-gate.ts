import { WorkerReleaseHealth } from "./worker-release-health";
import { WorkerCanaryEvaluator } from "./worker-canary-evaluator";

export class WorkerPromotionGate {
  evaluate(
    releaseId: string,
    health: string,
    canary: string,
    budgetAvailable: boolean,
    rollbackAvailable: boolean,
    capacityAvailable: boolean,
    confidence: number
  ): "ALLOW" | "DENY" | "DEFER" {
    if (!budgetAvailable || !rollbackAvailable || !capacityAvailable) return "DENY";
    if (health === "UNHEALTHY" || canary === "REGRESSION") return "DENY";
    if (confidence < 0.5) return "DEFER";
    if (health === "DEGRADED" || canary === "CONFLICTING") return "DEFER";
    return "ALLOW";
  }
}
