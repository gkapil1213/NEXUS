import { randomUUID } from 'crypto';
export function processProgressiveRollout(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    strategy: input.strategy || 'canary',
    state: input.state || 'planned',
  };
}
