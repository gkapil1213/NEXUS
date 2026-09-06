import { randomUUID } from 'crypto';
export function processRolloutPlan(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  let strategy = input.strategy ? input.strategy.toUpperCase() : 'CANARY';
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    strategy,
    stages: input.stages || [],
  };
}
