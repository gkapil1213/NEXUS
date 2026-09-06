import { randomUUID } from 'crypto';
export function processReleaseEvidence(input: any): any {
  return { id: randomUUID(), releaseId: input.releaseId, evidenceType: input.evidenceType || 'release', data: input.data || {} };
}
