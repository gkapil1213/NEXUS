import { randomUUID } from 'crypto';
export function processRecoveryRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return { id, idempotencyKey: input.idempotencyKey || id, executionId: input.executionId, reason: input.reason || null, state: input.fail ? 'failed' : 'success', result: input.result || 'success' };
}
