import { randomUUID } from 'crypto';
export function processRecoveryExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = { id, idempotencyKey: input.idempotencyKey || id, planId: input.planId, state: input.state || 'created', provider: input.provider || null, result: input.result || null, error: input.error || null, startedAt: input.startedAt || null, completedAt: input.completedAt || null };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      created: ['approved','cancelled'],
      approved: ['running','cancelled'],
      running: ['paused','verifying','failed','halted'],
      paused: ['running','halted'],
      halted: ['cancelled'],
      verifying: ['succeeded','failed'],
      succeeded: ['completed'],
      failed: ['rolled_back'],
      rolled_back: [],
      completed: [],
      cancelled: [],
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
