export type DurabilityClassification =
  | 'DURABLE_IMPROVEMENT'
  | 'PROVISIONAL_IMPROVEMENT'
  | 'TRANSIENT_IMPROVEMENT'
  | 'NO_MEASURABLE_CHANGE'
  | 'DEGRADATION'
  | 'REGRESSION'
  | 'INCONCLUSIVE'
  | 'INSUFFICIENT_DATA';

export interface DurabilityInput {
  baseline: Record<string, number>;
  postChangeObservations: Record<string, number>[];
  variance: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  durationHours: number;
  repeatedObservations: number;
  concurrentChanges: string[];
  rollbackEvents: number;
  telemetryFresh: boolean;
}

export function evaluateDurability(input: DurabilityInput): DurabilityClassification {
  if (!input.telemetryFresh) return 'INSUFFICIENT_DATA';
  if (input.repeatedObservations < 3) return 'INSUFFICIENT_DATA';

  const avgDelta = averageDeltaFromBaseline(input.baseline, input.postChangeObservations);

  if (input.concurrentChanges.length > 0 || input.rollbackEvents > 0) {
    return 'INCONCLUSIVE';
  }

  if (input.variance > 0.5) return 'INCONCLUSIVE';
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'INCONCLUSIVE';

  if (avgDelta > 0.05) {
    if (input.durationHours >= 168 && input.repeatedObservations >= 10) {
      return 'DURABLE_IMPROVEMENT';
    } else if (input.durationHours >= 72) {
      return 'PROVISIONAL_IMPROVEMENT';
    } else {
      return 'TRANSIENT_IMPROVEMENT';
    }
  } else if (avgDelta < -0.05) {
    return 'REGRESSION';
  } else {
    return 'NO_MEASURABLE_CHANGE';
  }
}

function averageDeltaFromBaseline(baseline: Record<string, number>, observations: Record<string, number>[]): number {
  if (observations.length === 0) return 0;
  const keys = Object.keys(baseline);
  let total = 0;
  let count = 0;
  for (const key of keys) {
    if (baseline[key] === 0) continue;
    for (const obs of observations) {
      if (obs[key] !== undefined) {
        total += (obs[key] - baseline[key]) / baseline[key];
        count++;
      }
    }
  }
  return count > 0 ? total / count : 0;
}
