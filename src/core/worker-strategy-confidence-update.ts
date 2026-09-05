export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface ConfidenceUpdateInput {
  historicalSuccess: number;
  historicalFailure: number;
  outcomeDurability: number; // 0-1
  sampleSize: number;
  recurrence: number;
  regression: boolean;
  environmentSimilarity: number; // 0-1
  executionQuality: number; // 0-1
  evidenceQuality: number; // 0-1
}

export function updateStrategyConfidence(input: ConfidenceUpdateInput): ConfidenceLevel {
  if (input.sampleSize < 5 || input.evidenceQuality < 0.3) return 'UNKNOWN';
  const total = input.historicalSuccess + input.historicalFailure;
  const successRate = total > 0 ? input.historicalSuccess / total : 0;
  const regressionPenalty = input.regression ? 0.5 : 0;
  const score = (successRate * 0.4 + input.outcomeDurability * 0.2 + input.environmentSimilarity * 0.2 + input.executionQuality * 0.2) - regressionPenalty;
  if (score >= 0.7 && input.sampleSize >= 20) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'UNKNOWN';
}