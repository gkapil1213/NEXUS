import { randomUUID } from 'crypto';
export function processAnomaly(input: any): any {
  return { id: randomUUID(), fingerprint: input.fingerprint || randomUUID(), serviceId: input.serviceId, anomalyType: input.anomalyType || 'generic', severity: input.severity || 'unknown', confidence: input.confidence || 0, evidenceRefs: input.evidenceRefs || [] };
}
