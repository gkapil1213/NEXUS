import { randomUUID } from 'crypto';

export function processExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: {
    id: string;
    releaseId?: string;
    operation?: string;
    status: string;
    validTransition?: boolean;
    blocked?: boolean;
  } = { id, releaseId: input.releaseId, operation: input.operation, status: input.status || 'CREATED' };

  if (input.from && input.to) {
    const validTransitions: Record<string, string[]> = {
      CREATED: ['QUEUED','CANCELLED'],
      QUEUED: ['RUNNING','CANCELLED'],
      RUNNING: ['PAUSED','HALTED','SUCCEEDED','FAILED'],
      PAUSED: ['RUNNING','CANCELLED'],
      HALTED: ['ROLLED_BACK','CANCELLED'],
      SUCCEEDED: ['COMPLETED'],
      FAILED: ['ROLLED_BACK'],
      ROLLED_BACK: ['FAILED'],
    };
    const allowed = validTransitions[input.from] || [];
    if (allowed.includes(input.to)) {
      result.validTransition = true;
      result.status = input.to;
    } else {
      throw new Error('Invalid transition');
    }
  }
  if (input.operation === 'halt') result.status = 'HALTED';
  if (input.circuitBreakerState === 'OPEN') result.blocked = true;
  return result;
}
