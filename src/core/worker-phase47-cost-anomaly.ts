import { randomUUID } from 'crypto';
export function processCostAnomaly(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    anomalyType: input.anomalyType || 'generic',
    evidence: input.evidence || [],
    confidence: input.confidence || 0,
  };
}
