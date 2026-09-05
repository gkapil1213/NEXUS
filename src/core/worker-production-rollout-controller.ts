export type RolloutStage = '10%' | '25%' | '50%' | '100%' | 'PAUSED' | 'ABORTED' | 'COMPLETED';

export interface RolloutState {
  currentStage: RolloutStage;
  metrics: { errorRate: number; latency: number; availability: number; saturation: number };
  thresholds: { maxErrorRate: number; maxLatency: number; minAvailability: number; maxSaturation: number };
}

export function evaluateRollout(state: RolloutState): { nextStage: RolloutStage; action: 'CONTINUE' | 'PAUSE' | 'ABORT' | 'COMPLETE' } {
  const { metrics, thresholds } = state;
  const severeError = metrics.errorRate > thresholds.maxErrorRate * 2;
  const severeLatency = metrics.latency > thresholds.maxLatency * 1.5;
  const severeAvailability = metrics.availability < thresholds.minAvailability - 0.1;
  const severeSaturation = metrics.saturation > 0.9;
  const anyViolation = metrics.errorRate > thresholds.maxErrorRate || metrics.latency > thresholds.maxLatency || metrics.availability < thresholds.minAvailability || metrics.saturation > thresholds.maxSaturation;
  if (anyViolation) {
    const severe = severeError || severeLatency || severeAvailability || severeSaturation;
    return severe ? { nextStage: 'ABORTED', action: 'ABORT' } : { nextStage: 'PAUSED', action: 'PAUSE' };
  }
  if (state.currentStage === '100%') return { nextStage: 'COMPLETED', action: 'COMPLETE' };
  const order: RolloutStage[] = ['10%', '25%', '50%', '100%'];
  const idx = order.indexOf(state.currentStage);
  if (idx < order.length - 1) return { nextStage: order[idx + 1], action: 'CONTINUE' };
  return { nextStage: 'COMPLETED', action: 'COMPLETE' };
}
