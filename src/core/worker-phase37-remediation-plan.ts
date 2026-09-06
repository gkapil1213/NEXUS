import { randomUUID } from 'crypto';
export function processRemediationPlan(input: any): any {
  return { id: randomUUID(), releaseId: input.releaseId, category: input.category || 'generic' };
}
