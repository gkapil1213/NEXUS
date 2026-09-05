export interface AttributionInput {
  strategyContribution: number;
  generationContribution: number;
  populationContribution: number;
  portfolioContribution: number;
  experimentContribution: number;
  metaExperimentContribution: number;
  evidenceQuality: number;
  temporalOrdering: boolean;
}

export function attributeOutcome(input: AttributionInput): { confidence: number; attributionValid: boolean } {
  if (!input.temporalOrdering || input.evidenceQuality < 0.3) return { confidence: 0, attributionValid: false };
  const total = input.strategyContribution + input.generationContribution + input.populationContribution + input.portfolioContribution + input.experimentContribution + input.metaExperimentContribution;
  if (total === 0) return { confidence: 0, attributionValid: false };
  return { confidence: Math.min(1, input.evidenceQuality * (1 - Math.abs(1 - total))), attributionValid: true };
}
