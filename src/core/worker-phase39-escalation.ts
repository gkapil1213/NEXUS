import { randomUUID } from 'crypto';
export function processEscalation(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, level: input.level || 'HIGH', reason: input.reason || '' };
}
