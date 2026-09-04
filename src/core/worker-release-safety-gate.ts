export class WorkerReleaseSafetyGate {
  evaluate(input: {
    workerHealth: string;
    controlPlaneHealth: string;
    consensusValid: boolean;
    epochValid: boolean;
    sloState: string;
    errorBudgetState: string;
    capacityAvailable: boolean;
    rollbackAvailable: boolean;
    incidents: number;
  }): "ALLOW" | "DENY" | "DEFER" | "REQUIRE_APPROVAL" {
    if (!input.consensusValid || !input.epochValid) return "DENY";
    if (!input.rollbackAvailable) return "DENY";
    if (input.sloState === "CRITICAL" || input.errorBudgetState === "CRITICAL") return "DENY";
    if (input.incidents > 0) return "DEFER";
    if (!input.capacityAvailable || !input.capacityAvailable) return "DEFER";
    if (input.workerHealth === "UNHEALTHY" || input.controlPlaneHealth === "DEGRADED") return "DEFER";
    if (input.sloState === "BREACHING" || input.errorBudgetState === "BREACHING") return "REQUIRE_APPROVAL";
    return "ALLOW";
  }
}
