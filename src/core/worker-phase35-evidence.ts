import { randomUUID } from 'crypto';

export function processEvidence(input: any): any {
  return { id: randomUUID(), operationId: input.operationId, data: {} };
}
