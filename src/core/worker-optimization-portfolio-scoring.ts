export interface PortfolioScoreInput {
  objectiveBenefit: number;
  confidence: number;
  riskPenalty: number;
  diversityFactor: number;
}

export function scorePortfolioCandidate(input: PortfolioScoreInput): number {
  return input.objectiveBenefit * input.confidence * input.diversityFactor - input.riskPenalty;
}
