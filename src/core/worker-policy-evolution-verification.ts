export type VerificationResult =
  | 'VERIFIED_IMPROVEMENT'
  | 'VERIFIED_REGRESSION'
  | 'NO_SIGNIFICANT_CHANGE'
  | 'CONFLICTED'
  | 'UNKNOWN'
  | 'INSUFFICIENT_DATA';

export interface VerificationInput {
  sampleSize: number;
  baselineReliability: number;
  actualReliability: number;
  baselineCost: number;
  actualCost: number;
  baselinePerformance: number;
  actualPerformance: number;
  errorChange: number;        // positive = increase in errors
  latencyChange: number;      // positive = increase in latency
  incidentChange: number;     // positive = increase in incidents
  rollbackEvents: number;
  telemetryFresh: boolean;
  conflictingMetrics: boolean;
}

export function verifyPolicyOutcome(input: VerificationInput): VerificationResult {
  if (!input.telemetryFresh) return 'UNKNOWN';
  if (input.sampleSize < 10) return 'INSUFFICIENT_DATA';
  if (input.conflictingMetrics) return 'CONFLICTED';

  const reliabilityDelta = input.actualReliability - input.baselineReliability;
  const costDelta = input.actualCost - input.baselineCost;
  const performanceDelta = input.actualPerformance - input.baselinePerformance;

  const improved = reliabilityDelta > 0.01 || performanceDelta > 5 || costDelta < 0;
  const regressed = reliabilityDelta < -0.01 || input.errorChange > 1 || input.latencyChange > 10 || input.incidentChange > 0 || input.rollbackEvents > 0;

  if (improved && !regressed) return 'VERIFIED_IMPROVEMENT';
  if (regressed && !improved) return 'VERIFIED_REGRESSION';
  if (!improved && !regressed) return 'NO_SIGNIFICANT_CHANGE';
  return 'CONFLICTED';
}
