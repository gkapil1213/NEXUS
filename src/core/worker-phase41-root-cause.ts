import { randomUUID } from 'crypto';
export function processRootCause(input: any): any {
  return { id: randomUUID(), serviceId: input.serviceId, hypothesisType: input.hypothesisType || 'unknown', confidence: input.confidence || 0, evidenceRefs: input.evidenceRefs || [], blastRadius: input.blastRadius || 'low' };
}
