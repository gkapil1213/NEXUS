import { randomUUID } from 'crypto';

export function processRemediationExecution(input: any): any {
  return { id: randomUUID(), remediationId: input.remediationId, status: 'RUNNING' };
}
