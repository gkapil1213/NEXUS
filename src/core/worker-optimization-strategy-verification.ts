export type VerificationResult = 'IMPROVED' | 'DEGRADED' | 'STABLE' | 'INSUFFICIENT_DATA' | 'REGRESSION';

export interface VerificationInput {
  expectedImprovement: number;
  actualImprovement: number;
  reliabilityChange: number;
  costChange: number;
  errorRateChange: number;
  latencyChange: number;
  availabilityChange: number;
  stability: boolean;
  rollbackStatus: string;
  sampleSize: number;
  telemetryFresh: boolean;
}

export function verifyStrategyOutcome(input: VerificationInput): VerificationResult {
  if (!input.telemetryFresh || input.sampleSize < 10) return 'INSUFFICIENT_DATA';
  if (input.rollbackStatus === 'ROLLED_BACK') return 'REGRESSION';
  if (input.reliabilityChange < -0.05 || input.errorRateChange > 0.05 || input.latencyChange > 10) return 'REGRESSION';
  if (input.actualImprovement > input.expectedImprovement * 0.5) return 'IMPROVED';
  if (input.actualImprovement < 0) return 'DEGRADED';
  return 'STABLE';
}
