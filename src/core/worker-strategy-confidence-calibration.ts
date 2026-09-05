export type CalibrationResult = 'WELL_CALIBRATED' | 'OVERCONFIDENT' | 'UNDERCONFIDENT' | 'INSUFFICIENT_EVIDENCE';

export interface CalibrationInput {
  predictedConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  observedSuccess: boolean;
  sampleSize: number;
}

export function calibrateConfidence(input: CalibrationInput): CalibrationResult {
  if (input.sampleSize < 5 || input.predictedConfidence === 'UNKNOWN') return 'INSUFFICIENT_EVIDENCE';
  const confidenceMap = { HIGH: 0.9, MEDIUM: 0.7, LOW: 0.4 };
  const predicted = confidenceMap[input.predictedConfidence] ?? 0;
  const observed = input.observedSuccess ? 1 : 0;
  const error = predicted - observed;
  if (Math.abs(error) < 0.2) return 'WELL_CALIBRATED';
  if (error > 0.2) return 'OVERCONFIDENT';
  return 'UNDERCONFIDENT';
}
