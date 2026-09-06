import { randomUUID } from 'crypto';

export function processLearning(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, recommendation: input.recommendation || '' };
}
