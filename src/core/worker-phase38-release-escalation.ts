import { randomUUID } from 'crypto';
export function processReleaseEscalation(input: any): any {
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    level: input.level || 'HIGH',
    reason: input.reason || '',
    createdAt: new Date().toISOString(),
  };
}
