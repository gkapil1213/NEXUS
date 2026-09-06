import { randomUUID } from 'crypto';
export function processTrend(input: any): any {
  return { id: randomUUID(), resourceId: input.resourceId, trendDirection: input.trendDirection || 'unknown', confidence: input.confidence || 0 };
}
