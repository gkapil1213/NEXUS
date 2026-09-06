import { randomUUID } from 'crypto';
export function processEscalation(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, reason: input.reason || 'mandatory' };
}
