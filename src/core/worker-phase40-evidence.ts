import { randomUUID } from 'crypto';
export function processEvidence(input: any): any {
  return { id: randomUUID(), incidentId: input.incidentId, evidenceType: input.evidenceType || 'incident', data: input.data || {} };
}
