export interface ExperimentConfidenceInput {
  sampleSize: number;
  successCount: number;
  outcomeConsistency: number;
  evidenceQuality: number;
  attributionConfidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
}

export function calculateExperimentConfidence(input: ExperimentConfidenceInput): number {
  if (input.sampleSize < 5) return 0;
  const successRate = input.successCount / input.sampleSize;
  const base = successRate * 0.4 + input.outcomeConsistency * 0.2 + input.evidenceQuality * 0.2 + input.attributionConfidence * 0.2;
  const riskPenalty = input.riskLevel === 'CRITICAL' ? 0.4 : input.riskLevel === 'HIGH' ? 0.2 : input.riskLevel === 'UNKNOWN' ? 0.3 : 0;
  return Math.max(0, Math.min(1, base - riskPenalty));
}
