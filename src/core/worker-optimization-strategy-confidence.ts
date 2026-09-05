export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export interface ConfidenceInput {
  sampleSize: number;
  historicalRepetitions: number;
  evidenceFreshness: 'FRESH' | 'STALE';
  outcomeConsistency: number; // 0-1
  causalAttributionQuality: number; // 0-1
  interactionUncertainty: number; // 0-1, higher = more uncertain
  strategyComplexity: number; // 0-1
  productionSimilarity: number; // 0-1
  durability: number; // 0-1
}

export function evaluateStrategyConfidence(input: ConfidenceInput): ConfidenceLevel {
  if (input.evidenceFreshness === 'STALE' || input.sampleSize < 10 || input.historicalRepetitions < 3) {
    return 'INSUFFICIENT';
  }
  const score =
    (input.outcomeConsistency + input.causalAttributionQuality + input.productionSimilarity + input.durability) / 4
    - input.interactionUncertainty * 0.5
    - input.strategyComplexity * 0.2;
  if (score >= 0.7 && input.sampleSize >= 50) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  return 'LOW';
}
