export type StabilityDecision = 'STABLE' | 'UNSTABLE' | 'COOLDOWN' | 'THRASHING' | 'UNKNOWN';

export interface StabilityInput {
  recentPolicyChanges: number;
  recentRollbacks: number;
  recentFailedRollouts: number;
  cooldownActive: boolean;
  minObservationWindowSatisfied: boolean;
  oscillationDetected: boolean;
  adaptationFrequencyExceeded: boolean;
  rollbackFrequencyExceeded: boolean;
  telemetryFresh: boolean;
}

export function evaluatePolicyStability(input: StabilityInput): StabilityDecision {
  if (!input.telemetryFresh) return 'UNKNOWN';

  // Thrashing indicators take precedence over cooldown
  if (input.oscillationDetected || input.adaptationFrequencyExceeded || input.rollbackFrequencyExceeded) {
    return 'THRASHING';
  }

  if (input.cooldownActive) return 'COOLDOWN';
  if (!input.minObservationWindowSatisfied) return 'COOLDOWN';

  if (input.recentRollbacks > 2 || input.recentFailedRollouts > 2) {
    return 'UNSTABLE';
  }
  if (input.recentPolicyChanges > 5) return 'UNSTABLE';

  return 'STABLE';
}
