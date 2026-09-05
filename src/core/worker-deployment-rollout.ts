export type RolloutState = 'PENDING' | 'PROGRESSING' | 'PAUSED' | 'ABORTED' | 'COMPLETED';

export interface CanaryRolloutState {
  currentPercent: number;
  desiredPercent: number;
  step: number;
  health: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  errorRate: number;
  latency: number;
  availability: number;
  policyThresholds: { maxErrorRate: number; maxLatency: number; minAvailability: number };
}

export function evaluateCanaryRollout(state: CanaryRolloutState): { nextState: RolloutState; nextPercent: number } {
  if (state.health === 'UNHEALTHY' || state.errorRate > state.policyThresholds.maxErrorRate || state.latency > state.policyThresholds.maxLatency || state.availability < state.policyThresholds.minAvailability) {
    return { nextState: 'ABORTED', nextPercent: state.currentPercent };
  }
  if (state.currentPercent < state.desiredPercent) {
    const next = Math.min(state.desiredPercent, state.currentPercent + state.step);
    return { nextState: 'PROGRESSING', nextPercent: next };
  }
  return { nextState: 'COMPLETED', nextPercent: state.currentPercent };
}
