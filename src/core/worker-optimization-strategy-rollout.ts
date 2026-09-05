export type StrategyRolloutStage = 'PLAN' | 'SHADOW' | 'CANARY' | 'LIMITED' | 'EXPANDED' | 'FLEET' | 'VERIFIED';

export interface StrategyRolloutInput {
  currentStage: StrategyRolloutStage;
  metrics: { errorRate: number; latency: number; reliability: number; cost: number };
  thresholds: { maxErrorRate: number; maxLatency: number; minReliability: number; maxCost: number };
}

export function evaluateStrategyRollout(input: StrategyRolloutInput): { nextStage: StrategyRolloutStage; action: 'CONTINUE' | 'HOLD' | 'ROLLBACK' } {
  const { metrics, thresholds } = input;
  if (metrics.errorRate > thresholds.maxErrorRate || metrics.latency > thresholds.maxLatency || metrics.reliability < thresholds.minReliability || metrics.cost > thresholds.maxCost) {
    return { nextStage: 'PLAN', action: 'HOLD' };
  }
  const order: StrategyRolloutStage[] = ['PLAN', 'SHADOW', 'CANARY', 'LIMITED', 'EXPANDED', 'FLEET', 'VERIFIED'];
  const idx = order.indexOf(input.currentStage);
  const next = idx < order.length - 1 ? order[idx + 1] : 'VERIFIED';
  return { nextStage: next, action: 'CONTINUE' };
}
