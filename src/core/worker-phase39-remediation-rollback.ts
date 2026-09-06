import { randomUUID } from 'crypto';
export function processRemediationRollback(input: any): any {
  return { id: randomUUID(), remediationId: input.remediationId, status: input.fail ? 'FAILED' : 'SUCCESS' };
}
