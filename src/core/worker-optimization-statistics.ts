export type StatisticalResult =
  | 'STATISTICALLY_SUPPORTED'
  | 'PRACTICALLY_SIGNIFICANT'
  | 'STATISTICALLY_SUPPORTED_BUT_TOO_SMALL'
  | 'INSUFFICIENT_DATA'
  | 'REGRESSION'
  | 'UNKNOWN';

export interface StatisticalInput {
  sampleSize: number;
  minimumSampleSize: number;
  observationWindowDays: number;
  minimumObservationWindowDays: number;
  confidenceThreshold: number; // 0.0 - 1.0
  effectSize: number;
  minimumEffectSize: number;
  regressionDetected: boolean;
  telemetryFresh: boolean;
  confidenceLevel: number; // computed elsewhere, e.g., 0.95
}

export function evaluateStatistics(input: StatisticalInput): StatisticalResult {
  if (!input.telemetryFresh) return 'UNKNOWN';
  if (input.sampleSize < input.minimumSampleSize) return 'INSUFFICIENT_DATA';
  if (input.observationWindowDays < input.minimumObservationWindowDays) return 'INSUFFICIENT_DATA';
  if (input.regressionDetected) return 'REGRESSION';
  if (input.confidenceLevel < input.confidenceThreshold) return 'INSUFFICIENT_DATA';
  if (input.effectSize < input.minimumEffectSize) return 'STATISTICALLY_SUPPORTED_BUT_TOO_SMALL';
  return 'STATISTICALLY_SUPPORTED';
}
