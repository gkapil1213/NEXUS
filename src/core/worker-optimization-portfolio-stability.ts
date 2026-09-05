export type StabilityState = 'STABLE' | 'WATCH' | 'UNSTABLE' | 'THRASHING';

export interface PortfolioStabilityInput {
  promoteCount: number;
  rollbackCount: number;
  oscillationDetected: boolean;
  repeatedRollback: boolean;
  telemetryFresh: boolean;
  cooldownActive: boolean;
}

export function evaluatePortfolioStability(input: PortfolioStabilityInput): StabilityState {
  if (!input.telemetryFresh) return 'WATCH';
  if (input.oscillationDetected || input.repeatedRollback) return 'THRASHING';
  if (input.rollbackCount > 2 || (input.promoteCount > 3 && input.rollbackCount > 1)) return 'UNSTABLE';
  if (input.cooldownActive) return 'WATCH';
  return 'STABLE';
}
