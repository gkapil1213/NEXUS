import { randomUUID } from 'crypto';
export function processRemediationExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = { id, idempotencyKey: input.idempotencyKey || id, planId: input.planId, state: input.state || 'created', attempts: input.attempts || 1, provider: input.provider || null, result: input.result || null, error: input.error || null, startedAt: input.startedAt || null, completedAt: input.completedAt || null };
  if (input.from && input.to) {
    const valid: Record<string, string[]> = {
      created: ['approved','cancelled'],
      approved: ['running','cancelled'],
      running: ['paused','succeeded','failed','halted'],
      paused: ['running','halted'],
      halted: ['rolling_back','cancelled'],
      succeeded: ['completed'],
      failed: ['rolling_back'],
      rolling_back: ['rolled_back','failed'],
      rolled_back: ['failed'],
    };
    const allowed = valid[input.from] || [];
    if (allowed.includes(input.to)) {
      result.validTransition = true;
      result.state = input.to;
    } else throw new Error('Invalid transition');
  }
  if (input.operation === 'halt') result.state = 'halted';
  if (input.circuitBreakerState === 'OPEN') result.blocked = true;
  return result;
}
