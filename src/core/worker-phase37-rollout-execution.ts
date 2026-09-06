import { randomUUID } from 'crypto';
export function processRolloutExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    planId: input.planId,
    stageId: input.stageId,
    status: input.status || 'PLANNED',
  };
}
