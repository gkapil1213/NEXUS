export type EvolutionConfidence = 'INSUFFICIENT_DATA' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export interface EvolutionConfidenceInput {
  sampleSize: number;
  historicalSuccessCount: number;
  outcomeConsistency: number; // 0-1
  durability: number; // 0-1
  recentness: number; // 0-1
  regressionEvidence: boolean;
  uncertainty: number; // 0-1
  strategyAge: number; // days
  driftSeverity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  failureHistoryCount: number;
}

export function evaluateEvolutionConfidence(input: EvolutionConfidenceInput): EvolutionConfidence {
  if (input.sampleSize < 5) return 'INSUFFICIENT_DATA';
  const successRate = input.historicalSuccessCount / input.sampleSize;
  const baseScore = (successRate * 0.4 + input.outcomeConsistency * 0.25 + input.durability * 0.15 + input.recentness * 0.2);
  const penalty = (input.regressionEvidence ? 0.3 : 0) + input.uncertainty * 0.2 + input.failureHistoryCount * 0.05;
  const driftPenalty = input.driftSeverity === 'CRITICAL' ? 0.4 : input.driftSeverity === 'HIGH' ? 0.25 : input.driftSeverity === 'MEDIUM' ? 0.1 : 0;
  const score = baseScore - penalty - driftPenalty;
  if (score >= 0.8 && input.sampleSize >= 50 && input.strategyAge > 7) return 'VERY_HIGH';
  if (score >= 0.65) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'INSUFFICIENT_DATA';
}
