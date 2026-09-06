import { randomUUID } from 'crypto';
export function processSecurityAnomaly(input: any): any {
  return {
    id: randomUUID(),
    assetId: input.assetId,
    anomalyType: input.anomalyType || 'generic',
    severity: input.severity || 'unknown',
    confidence: input.confidence || 0,
    baseline: input.baseline || null,
    observedValue: input.observedValue || null,
    expectedValue: input.expectedValue || null,
    state: input.state || 'open',
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
