import { randomUUID } from 'crypto';
export function processExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = { id, idempotencyKey: input.idempotencyKey || id, planId: input.planId, state: input.state || 'planned', provider: input.provider || null, result: input.result || null, error: input.error || null, startedAt: input.startedAt || null, completedAt: input.completedAt || null };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      planned: ['approval_required','approved','cancelled'],
      approval_required: ['approved','denied'],
      approved: ['running','cancelled'],
      running: ['succeeded','failed','halted'],
      halted: ['cancelled'],
      succeeded: ['completed'],
      failed: ['rolling_back'],
      rolling_back: ['rolled_back','rollback_failed'],
      rolled_back: [],
      rollback_failed: [],
      completed: [],
      denied: [],
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
