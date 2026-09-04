export type PreventionSafetyDecision = "ALLOW" | "DENY" | "DEFER" | "OBSERVE_ONLY" | "HUMAN_REVIEW";

export class WorkerPreventionSafetyGate {
  evaluate(input: {
    confidence: number;
    telemetryFresh: boolean;
    consensusValid: boolean;
    controlBudgetAvailable: boolean;
    workerTrusted: boolean;
    workerHealthy: boolean;
  }): PreventionSafetyDecision {
    if (!input.consensusValid || !input.telemetryFresh) return "DENY";
    if (!input.workerTrusted || !input.workerHealthy) return "DENY";
    if (!input.controlBudgetAvailable) return "DEFER";
    if (input.confidence < 0.5) return "OBSERVE_ONLY";
    if (input.confidence < 0.8) return "DEFER";
    return "ALLOW";
  }
}
