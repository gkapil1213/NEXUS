export type AttributionStatus =
  | 'CAUSALLY_SUPPORTED'
  | 'CORRELATED'
  | 'CONFOUNDED'
  | 'UNKNOWN'
  | 'INSUFFICIENT_DATA';

export interface AttributionInput {
  temporalOrdering: boolean;
  baselineMetrics: Record<string, number>;
  treatmentMetrics: Record<string, number>;
  controlMetrics?: Record<string, number>;
  concurrentChanges: string[];
  incidents: string[];
  telemetryQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  observationWindowDays: number;
  minObservationDays?: number;
}

export function attributeOutcome(input: AttributionInput): {
  status: AttributionStatus;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  confounders: string[];
} {
  const confounders: string[] = [];

  if (input.observationWindowDays < (input.minObservationDays ?? 7)) {
    return { status: 'INSUFFICIENT_DATA', confidence: 'UNKNOWN', confounders: [] };
  }
  if (input.telemetryQuality === 'LOW') {
    return { status: 'UNKNOWN', confidence: 'UNKNOWN', confounders: ['low telemetry quality'] };
  }

  if (!input.temporalOrdering) {
    return { status: 'CORRELATED', confidence: 'LOW', confounders: ['outcome may have preceded change'] };
  }

  if (input.concurrentChanges.length > 0 || input.incidents.length > 0) {
    confounders.push(...input.concurrentChanges, ...input.incidents);
    return { status: 'CONFOUNDED', confidence: 'MEDIUM', confounders };
  }

  if (input.controlMetrics) {
    const treatmentDelta = computeDelta(input.baselineMetrics, input.treatmentMetrics);
    const controlDelta = computeDelta(input.baselineMetrics, input.controlMetrics);
    const difference = Math.abs(treatmentDelta - controlDelta);
    if (difference > 0.1 && input.telemetryQuality === 'HIGH') {
      return { status: 'CAUSALLY_SUPPORTED', confidence: 'HIGH', confounders: [] };
    } else if (difference > 0.05) {
      return { status: 'CAUSALLY_SUPPORTED', confidence: 'MEDIUM', confounders: [] };
    }
  }

  return { status: 'CORRELATED', confidence: 'MEDIUM', confounders: [] };
}

function computeDelta(a: Record<string, number>, b: Record<string, number>): number {
  let total = 0;
  let count = 0;
  for (const key of Object.keys(a)) {
    if (b[key] !== undefined && a[key] !== undefined && a[key] !== 0) {
      total += Math.abs((b[key] - a[key]) / a[key]);
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}
