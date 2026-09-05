export interface EvolutionScoreInput {
  objectiveBenefit: number;
  confidence: 'INSUFFICIENT_DATA' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  evidenceQuality: number; // 0-1
  durabilityFactor: number; // 0-1
  interactionFactor: number; // 0-1 or >1
  riskPenalty: number;
  resourcePenalty: number;
}

export interface EvolutionScoreResult {
  score: number;
  components: { name: string; value: number }[];
}

const confidenceMultiplier: Record<string, number> = {
  INSUFFICIENT_DATA: 0,
  LOW: 0.3,
  MEDIUM: 0.6,
  HIGH: 0.85,
  VERY_HIGH: 1.0,
};

export function scoreEvolutionCandidate(input: EvolutionScoreInput): EvolutionScoreResult {
  const conf = confidenceMultiplier[input.confidence] ?? 0;
  const score = input.objectiveBenefit * conf * input.evidenceQuality * input.durabilityFactor * input.interactionFactor - input.riskPenalty - input.resourcePenalty;
  return {
    score,
    components: [
      { name: 'objectiveBenefit', value: input.objectiveBenefit },
      { name: 'confidenceMultiplier', value: conf },
      { name: 'evidenceQuality', value: input.evidenceQuality },
      { name: 'durabilityFactor', value: input.durabilityFactor },
      { name: 'interactionFactor', value: input.interactionFactor },
      { name: 'riskPenalty', value: -input.riskPenalty },
      { name: 'resourcePenalty', value: -input.resourcePenalty },
    ],
  };
}
