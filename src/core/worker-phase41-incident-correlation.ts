import { randomUUID } from 'crypto';
export function processIncidentCorrelation(input: any): any {
  return { id: randomUUID(), findingId: input.findingId, incidentId: input.incidentId, correlationType: input.correlationType || 'related' };
}
