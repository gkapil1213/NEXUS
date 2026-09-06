import { randomUUID } from 'crypto';
export function processHalt(input: any): any {
  return { id: input.idempotencyKey || randomUUID(), releaseId: input.releaseId, reason: input.reason || 'manual' };
}
