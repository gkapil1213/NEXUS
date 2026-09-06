import { randomUUID } from 'crypto';
export function processEvidence(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, evidenceType: input.evidenceType || 'capacity', data: input.data || {}, timestamp: input.timestamp || new Date().toISOString() };
}
