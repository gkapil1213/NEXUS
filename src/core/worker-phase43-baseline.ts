import { randomUUID } from 'crypto';
export function processBaseline(input: any): any {
  let confidence = input.confidence || 0;
  let trendDirection = input.trendDirection || 'stable';
  if (input.insufficient) return { id: randomUUID(), serviceId: input.serviceId, confidence: 0, insufficient: true };
  return { id: randomUUID(), serviceId: input.serviceId, metricType: input.metricType, baselineValue: input.baselineValue || 0, minValue: input.minValue, maxValue: input.maxValue, volatility: input.volatility || 0, trendDirection, confidence };
}
