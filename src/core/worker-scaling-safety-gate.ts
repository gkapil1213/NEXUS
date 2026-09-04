export type ScalingSafetyDecision = "ALLOW" | "DENY" | "DEFER" | "OBSERVE_ONLY";

export class WorkerScalingSafetyGate {
  evaluate(input: {
    confidence: number;
    maxScaleDelta: number;
    affectedFleetPercent: number;
    incidentState: string;
    sloState: string;
    recoveryAvailable: boolean;
    rollbackAvailable: boolean;
    capacityBoundsOk: boolean;
    cooldownActive: boolean;
    repeatedAction: boolean;
    dependencyHealth: string;
    controlPlaneHealth: string;
  }): ScalingSafetyDecision {
    if (!input.capacityBoundsOk || !input.rollbackAvailable || !input.recoveryAvailable) return "DENY";
    if (input.incidentState === "CRITICAL" || input.sloState === "CRITICAL") return "DENY";
    if (input.controlPlaneHealth === "CRITICAL" || input.dependencyHealth === "CRITICAL") return "DENY";
    if (input.cooldownActive || input.repeatedAction) return "DEFER";
    if (input.confidence < 0.5) return "OBSERVE_ONLY";
    if (input.affectedFleetPercent > 0.5) return "DENY";
    return "ALLOW";
  }
}
