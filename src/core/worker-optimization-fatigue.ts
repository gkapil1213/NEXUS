export type FatigueState = 'HEALTHY' | 'WATCH' | 'FATIGUED' | 'THRASHING' | 'FROZEN';

export interface FatigueInput {
  changeFrequency: number;
  repeatedRollouts: number;
  repeatedRollbacks: number;
  unstableMetrics: boolean;
  oscillatingPolicies: boolean;
  insufficientObservationWindows: boolean;
  overlappingExperiments: number;
  resourceConsumption: number; // percentage 0-1
  telemetryFresh: boolean;
}

export function evaluateOptimizationFatigue(input: FatigueInput): FatigueState {
  if (!input.telemetryFresh) return 'FROZEN';
  if (input.oscillatingPolicies || input.repeatedRollbacks > 5) {
    return 'THRASHING';
  }
  if (input.overlappingExperiments > 5 || input.resourceConsumption > 0.9) {
    return 'FROZEN';
  }
  if (input.insufficientObservationWindows || input.changeFrequency > 20) {
    return 'FATIGUED';
  }
  if (input.unstableMetrics || input.repeatedRollouts > 5) {
    return 'WATCH';
  }
  return 'HEALTHY';
}
