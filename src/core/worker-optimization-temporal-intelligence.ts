export type TemporalOutcomeClassification =
  | 'SHORT_LIVED_IMPROVEMENT'
  | 'PERSISTENT_IMPROVEMENT'
  | 'DELAYED_REGRESSION'
  | 'DELAYED_BENEFIT'
  | 'SEASONAL_VARIATION'
  | 'RECURRING_DEGRADATION'
  | 'PERIODIC_OPPORTUNITY'
  | 'TEMPORAL_DRIFT'
  | 'UNKNOWN'
  | 'INSUFFICIENT_DATA';

export interface TemporalObservation {
  window: 'IMMEDIATE' | 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONG_TERM';
  metricDelta: Record<string, number>;
  sampleSize: number;
  freshness: 'FRESH' | 'STALE';
}

export interface TemporalInput {
  observations: TemporalObservation[];
  minimumSamples?: number;
}

export function classifyTemporalOutcome(input: TemporalInput): TemporalOutcomeClassification {
  const minSamples = input.minimumSamples ?? 10;
  if (!input.observations || input.observations.length === 0) return 'INSUFFICIENT_DATA';
  const fresh = input.observations.filter(o => o.freshness === 'FRESH' && o.sampleSize >= minSamples);
  if (fresh.length === 0) return 'INSUFFICIENT_DATA';
  // Sort by horizon order
  const order: Record<string, number> = { IMMEDIATE: 0, SHORT_TERM: 1, MEDIUM_TERM: 2, LONG_TERM: 3 };
  const sorted = [...fresh].sort((a,b) => order[a.window] - order[b.window]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const firstDelta = averageDelta(first.metricDelta);
  const lastDelta = averageDelta(last.metricDelta);
  if (firstDelta > 0 && lastDelta > 0) return 'PERSISTENT_IMPROVEMENT';
  if (firstDelta > 0 && lastDelta < 0) return 'DELAYED_REGRESSION';
  if (firstDelta <= 0 && lastDelta > 0) return 'DELAYED_BENEFIT';
  if (firstDelta > 0 && lastDelta === 0) return 'SHORT_LIVED_IMPROVEMENT';
  if (firstDelta < 0 && lastDelta < 0) return 'RECURRING_DEGRADATION';
  return 'UNKNOWN';
}

function averageDelta(metrics: Record<string, number>): number {
  const values = Object.values(metrics);
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
