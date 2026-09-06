import { randomUUID } from 'crypto';
export function processRollback(input: any): any {
  return {
    id: input.idempotencyKey || randomUUID(),
    releaseId: input.releaseId,
    status: input.fail ? 'FAILED' : 'SUCCESS',
    verificationResult: input.verificationResult || 'SUCCESS',
  };
}
