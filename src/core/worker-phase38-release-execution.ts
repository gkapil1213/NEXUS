import { randomUUID } from 'crypto';
export function processReleaseExecution(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  const result: any = {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    waveId: input.waveId || null,
    provider: input.provider || null,
    environment: input.environment || null,
    operation: input.operation || 'deploy',
    status: input.status || 'PENDING',
    attempt: input.attempt || 1,
    error: input.error || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
  };
  if (input.from && input.to) {
    const validTransitions: Record<string, string[]> = {
      PENDING: ['APPROVED','CANCELLED'],
      APPROVED: ['RUNNING','CANCELLED'],
      RUNNING: ['PAUSED','SUCCEEDED','FAILED','HALTED'],
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
