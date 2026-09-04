export type ReliabilityState = "HEALTHY" | "DEGRADED" | "CRITICAL" | "INSUFFICIENT_DATA";

export interface FleetReliabilityOptimizerInput {
  serviceReliability: number;
  dependencyReliability: number;
  changeRisk: string;
  errorBudgetRemaining: number;
  incidentCount: number;
  confidence: number;
}

export interface FleetOptimizationResult {
  state: ReliabilityState;
  recommendation: string;
  reason: string;
  confidence: number;
}

export class WorkerFleetReliabilityOptimizer {
  evaluate(input: FleetReliabilityOptimizerInput): FleetOptimizationResult {
    if (!Number.isFinite(input.serviceReliability) || !Number.isFinite(input.dependencyReliability) || input.confidence < 0.5) {
      return { state: "INSUFFICIENT_DATA", recommendation: "OBSERVE", reason: "insufficient_data_or_low_confidence", confidence: input.confidence };
    }
    let state: ReliabilityState = "HEALTHY";
    let recommendation = "HOLD";
    const reliability = Math.min(input.serviceReliability, input.dependencyReliability);
    if (input.incidentCount > 0) {
      state = "CRITICAL";
      recommendation = "ROLLBACK";
    } else if (input.changeRisk === "CRITICAL" || input.errorBudgetRemaining < 0.1) {
      state = "CRITICAL";
      recommendation = "HOLD_CHANGE";
    } else if (input.changeRisk === "HIGH" || reliability < 0.8) {
      state = "DEGRADED";
      recommendation = "REDUCE_WAVE";
    }
    return { state, recommendation, reason: `reliability:${reliability.toFixed(2)}`, confidence: input.confidence };
  }
}
