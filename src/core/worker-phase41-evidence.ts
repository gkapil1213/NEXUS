import { randomUUID } from 'crypto';
export function processEvidence(input: any): any {
  return { id: randomUUID(), serviceId: input.serviceId, evidenceType: input.evidenceType || 'reliability', data: input.data || {} };
}
