import { randomUUID } from 'crypto';
export function processIncidentSignal(input: any): any {
  const fingerprint = input.signalFingerprint || input.idempotencyKey || randomUUID();
  return {
    id: fingerprint,
    signalFingerprint: fingerprint,
    incidentId: input.incidentId || null,
    signalType: input.signalType || 'unknown',
    observedValue: input.observedValue || null,
    thresholdContext: input.thresholdContext || null,
    source: input.source || null,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
