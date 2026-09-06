import { randomUUID } from 'crypto';
export function processReleaseRollback(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    reason: input.reason || null,
    status: input.fail ? 'FAILED' : 'SUCCESS',
    verificationResult: input.verificationResult || 'SUCCESS',
  };
}
