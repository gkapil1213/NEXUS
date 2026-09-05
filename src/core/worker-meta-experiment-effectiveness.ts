export interface EffectivenessInput {
  improvementRate: number;
  discoveryRate: number;
  evidenceSufficiency: number;
  falsePromotionRate: number;
  regressionRate: number;
  rollbackRate: number;
  resourceConsumption: number;
  timeToConfidence: number;
}

export function evaluateMetaEffectiveness(input: EffectivenessInput): number {
  return input.improvementRate * 0.25 + input.discoveryRate * 0.2 + input.evidenceSufficiency * 0.15 - input.falsePromotionRate * 0.15 - input.regressionRate * 0.1 - input.rollbackRate * 0.1 - input.resourceConsumption * 0.05 + Math.max(0, 1 - input.timeToConfidence / 100) * 0.05;
}
