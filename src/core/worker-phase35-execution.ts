import { randomUUID } from 'crypto';

export function processExecution(input: any): any {
  const id = input.idempotencyKey ? input.idempotencyKey : randomUUID();
  const result: any = {
    id,
    pipelineId: input.pipelineId,
    operation: input.operation,
    status: input.status || 'PLANNED',
  };
  if (input.from && input.to) {
    const validTransitions: Record<string, string[]> = {
      PLANNED: ['APPROVED', 'HALTED', 'CANCELLED'],
      APPROVED: ['RUNNING', 'CANCELLED'],
      RUNNING: ['VERIFYING', 'FAILED', 'HALTED'],
      VERIFYING: ['SUCCEEDED', 'FAILED'],
      FAILED: ['ROLLED_BACK'],
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
