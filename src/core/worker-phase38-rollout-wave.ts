import { randomUUID } from 'crypto';
export function processRolloutWave(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    idempotencyKey: input.idempotencyKey || randomUUID(),
    releaseId: input.releaseId,
    planId: input.planId,
    sequence: input.sequence || 1,
    percentage: input.percentage || 0,
    status: input.status || 'PENDING',
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
  };
}
