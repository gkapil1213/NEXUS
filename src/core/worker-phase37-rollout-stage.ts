import { randomUUID } from 'crypto';
export function processRolloutStage(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    planId: input.planId,
    stageOrder: input.stageOrder || 1,
    targetPercent: input.targetPercent || 0,
    healthGateCriteria: input.healthGateCriteria || 'HEALTHY',
    observationWindowSeconds: input.observationWindowSeconds || 300,
  };
}
