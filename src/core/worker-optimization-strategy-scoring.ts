export interface StrategyScoreInput {
  objectiveBenefit: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  evidenceQuality: number; // 0-1
  durabilityFactor: number; // 0-1
  interactionFactor: number; // 0-1, 1=neutral, >1 synergy, <1 antagonistic
  riskPenalty: number;
  resourcePenalty: number;
}

export interface StrategyScoreResult {
  score: number;
  components: { name: string; value: number }[];
}

const confidenceMultiplier: Record<string, number> = {
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.4,
  INSUFFICIENT: 0.0,
};

export function scoreStrategy(input: StrategyScoreInput): StrategyScoreResult {
  const conf = confidenceMultiplier[input.confidence] ?? 0;
  const score =
    input.objectiveBenefit *
    conf *
    input.evidenceQuality *
    input.durabilityFactor *
    input.interactionFactor
    - input.riskPenalty
    - input.resourcePenalty;

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
