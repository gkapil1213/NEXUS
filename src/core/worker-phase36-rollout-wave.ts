import { randomUUID } from 'crypto';
export function processRolloutWave(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    idempotency_key: input.idempotencyKey || id,
    planId: input.planId,
    waveOrder: input.waveOrder || 1,
    targetEnv: input.targetEnv || 'production',
    trafficPercent: input.trafficPercent || 0,
    healthGate: input.healthGate || 'HEALTHY',
    minObservationWindow: input.minObservationWindow || 300,
    promotionCondition: input.promotionCondition || 'health == HEALTHY',
    haltCondition: input.haltCondition || 'error_rate > 0.05',
    rollbackCondition: input.rollbackCondition || 'error_rate > 0.10',
    approvalRequired: input.approvalRequired || false,
    riskLevel: input.riskLevel || 'LOW',
  };
}
