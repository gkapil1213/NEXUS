import { ReleaseState } from "./worker-release-state";
import { ReleaseHealthState } from "./worker-release-health";
import { CanaryState } from "./worker-canary-evaluator";

export type ReleaseDecision = "PROMOTE" | "HOLD" | "PAUSE" | "ROLLBACK" | "ABORT" | "OBSERVE";

export class WorkerReleaseDecision {
  decide(
    state: ReleaseState,
    health: ReleaseHealthState,
    canary: CanaryState,
    budgetAvailable: boolean,
    epochValid: boolean,
    consensusValid: boolean,
    rollbackAvailable: boolean
  ): { decision: ReleaseDecision; reason: string } {
    if (!epochValid || !consensusValid) return { decision: "HOLD", reason: "control_plane_invalid" };
    if (health === "UNHEALTHY" || canary === "REGRESSION") return rollbackAvailable ? { decision: "ROLLBACK", reason: "health_regression" } : { decision: "ABORT", reason: "rollback_unavailable" };
    if (!budgetAvailable) return { decision: "HOLD", reason: "budget_exhausted" };
    if (health === "DEGRADED" || canary === "CONFLICTING") return { decision: "PAUSE", reason: "degraded_or_conflicting" };
    if (state === "CANARY" && canary === "HEALTHY") return { decision: "PROMOTE", reason: "healthy_canary" };
    if (state === "OBSERVING" && canary === "HEALTHY") return { decision: "PROMOTE", reason: "healthy_observation" };
    return { decision: "OBSERVE", reason: "not_ready" };
  }
}
