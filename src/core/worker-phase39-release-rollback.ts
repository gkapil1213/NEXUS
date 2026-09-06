import { randomUUID } from 'crypto';
export function processReleaseRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    targetVersion: input.targetVersion || null,
    reason: input.reason || null,
    executionId: input.executionId || null,
    result: input.fail ? 'FAILED' : 'SUCCESS',
    createdAt: new Date().toISOString(),
  };
}
