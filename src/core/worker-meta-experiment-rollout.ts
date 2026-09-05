export type MetaRolloutStage = 'SHADOW' | 'CANARY' | 'LIMITED' | 'PROGRESSIVE' | 'FULL' | 'HOLD' | 'ROLLBACK';

export interface MetaRolloutInput {
  currentStage: MetaRolloutStage;
  metrics: { errorRate: number; latency: number; reliability: number; cost: number };
  thresholds: { maxErrorRate: number; maxLatency: number; minReliability: number; maxCost: number };
}

export function evaluateMetaRollout(input: MetaRolloutInput): { nextStage: MetaRolloutStage; action: 'CONTINUE' | 'HOLD' | 'ROLLBACK' } {
  const { metrics, thresholds } = input;
  if (metrics.errorRate > thresholds.maxErrorRate || metrics.latency > thresholds.maxLatency || metrics.reliability < thresholds.minReliability || metrics.cost > thresholds.maxCost) {
    return { nextStage: 'HOLD', action: 'HOLD' };
  }
  if (input.currentStage === 'HOLD') return { nextStage: 'ROLLBACK', action: 'ROLLBACK' };
  const order: MetaRolloutStage[] = ['SHADOW', 'CANARY', 'LIMITED', 'PROGRESSIVE', 'FULL'];
  const idx = order.indexOf(input.currentStage);
  const next = idx < order.length - 1 ? order[idx + 1] : 'FULL';
  return { nextStage: next, action: 'CONTINUE' };
}
