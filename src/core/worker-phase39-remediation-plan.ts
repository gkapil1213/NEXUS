import { randomUUID } from 'crypto';
export function processRemediationPlan(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    rootCause: input.rootCause || null,
    action: input.action || null
  };
}
