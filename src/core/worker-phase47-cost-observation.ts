import { randomUUID } from 'crypto';
export function processCostObservation(input: any): any {
  return {
    id: randomUUID(),
    resourceId: input.resourceId,
    amount: input.amount,
    currency: input.currency || 'USD',
    billingPeriod: input.billingPeriod || null,
    provider: input.provider || null,
    source: input.source || null,
    confidence: input.confidence || 0,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
