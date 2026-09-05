export type RolloutStage = '0%' | '5%' | '10%' | '25%' | '50%' | '75%' | '100%';
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface ProgressiveDeliveryState {
  currentStage: RolloutStage;
  health: HealthStatus;
  errorRate: number;
  latency: number;
  availability: number;
  thresholds: { maxErrorRate: number; maxLatency: number; minAvailability: number };
}

export function advanceRollout(state: ProgressiveDeliveryState): { nextStage: RolloutStage; action: 'CONTINUE' | 'HALT' } {
  if (state.health === 'UNHEALTHY' || state.health === 'UNKNOWN' || state.errorRate > state.thresholds.maxErrorRate || state.latency > state.thresholds.maxLatency || state.availability < state.thresholds.minAvailability) {
    return { nextStage: state.currentStage, action: 'HALT' };
  }
  const order: RolloutStage[] = ['0%', '5%', '10%', '25%', '50%', '75%', '100%'];
  const idx = order.indexOf(state.currentStage);
  if (idx < order.length - 1) return { nextStage: order[idx + 1], action: 'CONTINUE' };
  return { nextStage: state.currentStage, action: 'HALT' };
}
