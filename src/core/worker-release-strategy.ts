import { ChangeRiskClass } from "./worker-change-risk";

export type ReleaseStrategy = "DIRECT" | "STAGED" | "CANARY" | "BLUE_GREEN" | "PAUSED" | "ROLLBACK_ONLY" | "BLOCKED";

export class WorkerReleaseStrategy {
  select(riskClass: ChangeRiskClass, errorBudgetState: string, activeIncidents: number): ReleaseStrategy {
    if (riskClass === "CRITICAL" || errorBudgetState === "CRITICAL") return "BLOCKED";
    if (activeIncidents > 0) return "PAUSED";
    if (riskClass === "HIGH" || errorBudgetState === "BREACHING") return "CANARY";
    if (riskClass === "GUARDED") return "STAGED";
    return "DIRECT";
  }
}
