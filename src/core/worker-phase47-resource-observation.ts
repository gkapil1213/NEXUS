import { randomUUID } from 'crypto';
export function processResourceObservation(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    metricType: input.metricType || 'unknown',
    value: input.value,
    unit: input.unit || null,
    observedAt: input.observedAt || new Date().toISOString(),
    source: input.source || null,
    confidence: input.confidence || 0,
  };
}
