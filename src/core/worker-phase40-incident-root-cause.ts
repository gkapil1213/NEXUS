import { randomUUID } from 'crypto';
export function processIncidentRootCause(input: any): any {
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    candidateCause: input.candidateCause || '',
    confidence: input.confidence || 0,
    evidenceRefs: input.evidenceRefs || [],
    isSelected: input.isSelected || false,
  };
}
