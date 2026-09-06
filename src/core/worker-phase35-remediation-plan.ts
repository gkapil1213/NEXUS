import { randomUUID } from 'crypto';

export function processRemediationPlan(input: any): any {
  const id = input.idempotencyKey ? input.idempotencyKey : randomUUID();
  return {
    id,
    pipelineId: input.pipelineId,
    category: input.category || 'generic',
    status: 'PLANNED',
  };
}
