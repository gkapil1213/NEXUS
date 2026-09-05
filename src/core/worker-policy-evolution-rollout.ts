export type RolloutStage = 'OBSERVE_ONLY' | 'CANARY' | 'LIMITED' | 'PROGRESSIVE' | 'FULL' | 'HOLD' | 'ROLLBACK';

export interface RolloutState {
  stage: RolloutStage;
  errorRate: number;
  latencyP95: number;
  reliability: number;
  cost: number;
  rollbackRate: number;
  incidentRate: number;
}

export interface RolloutInput {
  currentStage: RolloutStage;
  state: RolloutState;
  thresholds: {
    maxErrorRate: number;
    maxLatencyP95: number;
    minReliability: number;
    maxCost: number;
    maxRollbackRate: number;
    maxIncidentRate: number;
  };
}

export function evaluateRollout(input: RolloutInput): { nextStage: RolloutStage; action: 'CONTINUE' | 'HOLD' | 'ROLLBACK' } {
  const { state, thresholds } = input;

  if (state.errorRate > thresholds.maxErrorRate ||
      state.latencyP95 > thresholds.maxLatencyP95 ||
      state.reliability < thresholds.minReliability ||
      state.cost > thresholds.maxCost ||
      state.rollbackRate > thresholds.maxRollbackRate ||
      state.incidentRate > thresholds.maxIncidentRate) {
    return { nextStage: 'HOLD', action: 'HOLD' };
  }

  // If we are already in HOLD and conditions are bad, rollback
  if (input.currentStage === 'HOLD') {
    return { nextStage: 'ROLLBACK', action: 'ROLLBACK' };
  }

  // Otherwise progress to next stage
  const order: RolloutStage[] = ['OBSERVE_ONLY', 'CANARY', 'LIMITED', 'PROGRESSIVE', 'FULL'];
  const currentIndex = order.indexOf(input.currentStage);
  const nextStage = currentIndex < order.length - 1 ? order[currentIndex + 1] : 'FULL';
  return { nextStage, action: 'CONTINUE' };
}
