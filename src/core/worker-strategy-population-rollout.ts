export type PopulationRolloutStage = 'SHADOW' | 'LIMITED' | 'EXPANDED' | 'FULL' | 'HOLD' | 'ROLLBACK';

export interface PopulationRolloutInput {
  currentStage: PopulationRolloutStage;
  metrics: { errorRate: number; latency: number; reliability: number; cost: number };
  thresholds: { maxErrorRate: number; maxLatency: number; minReliability: number; maxCost: number };
}

export function evaluatePopulationRollout(input: PopulationRolloutInput): { nextStage: PopulationRolloutStage; action: 'CONTINUE' | 'HOLD' | 'ROLLBACK' } {
  const { metrics, thresholds } = input;
  if (metrics.errorRate > thresholds.maxErrorRate || metrics.latency > thresholds.maxLatency || metrics.reliability < thresholds.minReliability || metrics.cost > thresholds.maxCost) {
    return { nextStage: 'HOLD', action: 'HOLD' };
  }
  if (input.currentStage === 'HOLD') return { nextStage: 'ROLLBACK', action: 'ROLLBACK' };
  const order: PopulationRolloutStage[] = ['SHADOW', 'LIMITED', 'EXPANDED', 'FULL'];
  const idx = order.indexOf(input.currentStage);
  const next = idx < order.length - 1 ? order[idx + 1] : 'FULL';
  return { nextStage: next, action: 'CONTINUE' };
}
