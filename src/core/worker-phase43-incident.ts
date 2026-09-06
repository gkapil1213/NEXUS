import { randomUUID } from 'crypto';
export function processIncident(input: any): any {
  const id = input.fingerprint || randomUUID();
  return { id, fingerprint: input.fingerprint || id, serviceId: input.serviceId, severity: input.severity || 'unknown', confidence: input.confidence || 0, evidence: input.evidence || [], affectedResources: input.affectedResources || [], predictedImpact: input.predictedImpact || null, rootCauseHypothesis: input.rootCauseHypothesis || null, state: input.state || 'open' };
}
