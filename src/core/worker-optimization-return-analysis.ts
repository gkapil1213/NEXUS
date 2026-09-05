export type ReturnClassification =
  | 'HIGH_RETURN'
  | 'NORMAL_RETURN'
  | 'DIMINISHING_RETURN'
  | 'NEGATIVE_RETURN'
  | 'OPTIMIZATION_SATURATION'
  | 'INSUFFICIENT_DATA';

export interface ReturnAnalysisInput {
  attempts: number;
  cumulativeImprovement: number;
  incrementalImprovement: number;
  costPerImprovement: number;
  riskPerImprovement: number;
  failedAttempts: number;
  rollbackFrequency: number;
  telemetryFresh: boolean;
}

export function evaluateReturnAnalysis(input: ReturnAnalysisInput): ReturnClassification {
  if (!input.telemetryFresh) return 'INSUFFICIENT_DATA';
  if (input.attempts < 3) return 'INSUFFICIENT_DATA';

  const improvementRatio = input.attempts > 0 ? input.cumulativeImprovement / input.attempts : 0;
  const failureRatio = input.attempts > 0 ? input.failedAttempts / input.attempts : 0;

  if (input.incrementalImprovement <= 0 && input.cumulativeImprovement > 0) {
    return 'OPTIMIZATION_SATURATION';
  }

  if (input.incrementalImprovement < 0 || input.cumulativeImprovement < 0) {
    return 'NEGATIVE_RETURN';
  }

  if (input.rollbackFrequency > 0.3 || failureRatio > 0.5) {
    return 'NEGATIVE_RETURN';
  }

  if (input.rollbackFrequency > 0.15 || failureRatio > 0.25) {
    return 'DIMINISHING_RETURN';
  }

  if (improvementRatio >= 0.5 && input.incrementalImprovement > 0.1) {
    return 'HIGH_RETURN';
  }

  return 'NORMAL_RETURN';
}
