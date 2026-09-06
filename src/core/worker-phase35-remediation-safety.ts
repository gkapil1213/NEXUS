import { randomUUID } from 'crypto';

export function processRemediationSafety(input: any): any {
  return { id: randomUUID(), remediationId: input.remediationId, safe: input.safe ?? true };
}
