export type ObjectiveOutcome = 'ACHIEVED' | 'PARTIALLY_ACHIEVED' | 'UNCHANGED' | 'REGRESSED' | 'UNINTENDED_SIDE_EFFECTS';

export interface ObjectiveOutcomeInput {
  intendedObjective: string;
  intendedDelta: number;
  actualIntendedDelta: number;
  proxyMetricDelta: number;
  sideEffectsDetected: boolean;
}

export function evaluateObjectiveOutcome(input: ObjectiveOutcomeInput): ObjectiveOutcome {
  if (input.sideEffectsDetected) return 'UNINTENDED_SIDE_EFFECTS';
  const intendedImprovement = Math.abs(input.intendedDelta);
  const actualImprovement = input.intendedDelta > 0 ? input.actualIntendedDelta : -input.actualIntendedDelta;
  if (actualImprovement >= 0.5 * intendedImprovement) return 'ACHIEVED';
  if (actualImprovement > 0) return 'PARTIALLY_ACHIEVED';
  if (actualImprovement === 0) return 'UNCHANGED';
  return 'REGRESSED';
}

export function detectProxyMismatch(
  proxyMetricDelta: number,
  intendedMetricDelta: number
): boolean {
  return proxyMetricDelta > 0 && intendedMetricDelta < 0;
}
