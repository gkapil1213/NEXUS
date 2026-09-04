export type FleetControlDecision = "ALLOW" | "HOLD" | "PAUSE" | "REDUCE_WAVE" | "CANARY_ONLY" | "ROLLBACK" | "RECOVER" | "ESCALATE";

export class WorkerFleetControl {
  decide(serviceHealth: string, domainHealth: string, globalHealth: string, activeIncidents: number, errorBudgetState: string): FleetControlDecision {
    if (activeIncidents > 0) return "ROLLBACK";
    if (serviceHealth === "CRITICAL" || domainHealth === "CRITICAL" || globalHealth === "CRITICAL") return "PAUSE";
    if (serviceHealth === "DEGRADED" || domainHealth === "DEGRADED" || errorBudgetState === "BREACHING") return "REDUCE_WAVE";
    if (errorBudgetState === "CRITICAL") return "ROLLBACK";
    return "ALLOW";
  }
}
