import { randomUUID } from 'crypto';

export function processRemediationRollback(input: any): any {
  const status = input.fail ? 'FAILED' : 'SUCCESS';
  return { id: randomUUID(), remediationId: input.remediationId, status };
}
