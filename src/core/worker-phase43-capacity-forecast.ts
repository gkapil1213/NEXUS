import { randomUUID } from 'crypto';
export function processCapacityForecast(input: any): any {
  return { id: randomUUID(), serviceId: input.serviceId, resourceType: input.resourceType || 'cpu', currentObservation: input.currentObservation || 0, forecastValue: input.forecastValue || 0, confidence: input.confidence || 0, uncertainty: input.uncertainty || 0, thresholdCrossingEstimate: input.thresholdCrossingEstimate || null, evidence: input.evidence || [] };
}
