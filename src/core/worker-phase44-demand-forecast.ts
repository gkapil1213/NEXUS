import { randomUUID } from 'crypto';
export function processDemandForecast(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, horizon: input.horizon || '1h', expectedDemand: input.expectedDemand || 0, peakDemand: input.peakDemand || 0, confidence: input.confidence || 0, growthTrend: input.growthTrend || 0 };
}
