import { randomUUID } from 'crypto';
export function processWaste(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    wasteType: input.wasteType || 'generic',
    confidence: input.confidence || 0,
    evidence: input.evidence || [],
  };
}
