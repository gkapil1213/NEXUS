import { randomUUID } from 'crypto';
export function processRecoveryStep(input: any): any {
  return { id: randomUUID(), executionId: input.executionId, stepOrder: input.stepOrder || 1, action: input.action, state: input.state || 'pending', result: input.result || null };
}
