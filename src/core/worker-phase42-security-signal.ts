import { randomUUID } from 'crypto';
export function processSecuritySignal(input: any): any {
  const fingerprint = input.fingerprint || input.idempotencyKey || randomUUID();
  return {
    id: fingerprint,
    fingerprint,
    source: input.source || 'unknown',
    provider: input.provider || null,
    signalType: input.signalType || 'generic',
    assetId: input.assetId || null,
    timestamp: input.timestamp || new Date().toISOString(),
    severity: input.severity || 'unknown',
    confidence: input.confidence || 0,
    payloadMetadata: input.payloadMetadata || {},
  };
}
