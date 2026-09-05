export type PortfolioRolloutStage = 'PROPOSED' | 'APPROVED' | 'SHADOW' | 'CANARY' | 'PROGRESSIVE' | 'ACTIVE' | 'COMPLETED' | 'ROLLED_BACK';

export interface RolloutInput {
  currentStage: PortfolioRolloutStage;
  metrics: { errorRate: number; latency: number; reliability: number; cost: number };
  thresholds: { maxErrorRate: number; maxLatency: number; minReliability: number; maxCost: number };
}

export function evaluatePortfolioRollout(input: RolloutInput): { nextStage: PortfolioRolloutStage; action: 'CONTINUE' | 'HOLD' | 'ROLLBACK' } {
  const { metrics, thresholds } = input;
  if (metrics.errorRate > thresholds.maxErrorRate || metrics.latency > thresholds.maxLatency || metrics.reliability < thresholds.minReliability || metrics.cost > thresholds.maxCost) {
    return { nextStage: 'ROLLED_BACK', action: 'ROLLBACK' };
  }
  const order: PortfolioRolloutStage[] = ['PROPOSED', 'APPROVED', 'SHADOW', 'CANARY', 'PROGRESSIVE', 'ACTIVE', 'COMPLETED'];
  const idx = order.indexOf(input.currentStage);
  if (idx < order.length - 1) return { nextStage: order[idx + 1], action: 'CONTINUE' };
  return { nextStage: 'COMPLETED', action: 'CONTINUE' };
}
