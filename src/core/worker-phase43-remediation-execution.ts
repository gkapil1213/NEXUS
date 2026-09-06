import { randomUUID } from 'crypto';
export function processRemediationExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = { id, idempotencyKey: input.idempotencyKey || id, planId: input.planId, state: input.state || 'planned', provider: input.provider || null, result: input.result || null, error: input.error || null, startedAt: input.startedAt || null, completedAt: input.completedAt || null };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      planned: ['approved','cancelled'],
      approved: ['executing','cancelled'],
      executing: ['succeeded','failed','halted'],
      halted: ['cancelled'],
      succeeded: ['completed'],
      failed: [],
    };
    const allowed = valid[input.from] || [];
    if (!allowed.includes(input.to)) throw new Error('Invalid transition');
    result.validTransition = true;
    result.state = input.to;
  }
  if (input.operation === 'halt') result.state = 'halted';
  if (input.circuitBreakerState === 'OPEN') result.blocked = true;
  return result;
}
