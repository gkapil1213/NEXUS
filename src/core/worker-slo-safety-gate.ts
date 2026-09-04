import { SloState } from "./worker-slo";

export class WorkerSloSafetyGate {
  evaluate(sloState: SloState, burnRate: number, telemetryFresh: boolean, consensusValid: boolean): "ALLOW" | "DENY" | "DEFER" | "ROLLBACK" | "ESCALATE" {
    if (!consensusValid) return "DENY";
    if (!telemetryFresh) return "DEFER";
    if (sloState === "CRITICAL" || burnRate > 5) return "ROLLBACK";
    if (sloState === "BREACHING") return "ESCALATE";
    if (burnRate > 3) return "DEFER";
    return "ALLOW";
  }
}
