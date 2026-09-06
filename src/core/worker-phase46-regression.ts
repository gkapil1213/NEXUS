import { randomUUID } from 'crypto';
export function processRegression(input: any): any {
  return { id: randomUUID(), executionId: input.executionId, type: input.type || 'performance', detected: input.detected || false };
}
