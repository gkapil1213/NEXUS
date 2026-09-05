export interface PortfolioConfidenceInput {
  evidenceCount: number;
  duplicateCount: number;
  consistency: number;
  recency: number;
  durability: number;
  regressionHistory: number;
}

export function calculatePortfolioConfidence(input: PortfolioConfidenceInput): number {
  if (input.evidenceCount < 3) return 0;
  const unique = Math.max(1, input.evidenceCount - input.duplicateCount);
  return Math.min(1, (unique / input.evidenceCount) * (input.consistency * 0.5 + input.recency * 0.3 + input.durability * 0.2) - input.regressionHistory * 0.2);
}
