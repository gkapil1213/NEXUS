import { randomUUID } from 'crypto';
export function processSli(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    serviceId: input.serviceId,
    metricType: input.metricType,
    aggregation: input.aggregation || null,
    evaluationWindow: input.evaluationWindow || null,
    thresholdConfig: input.thresholdConfig || null,
  };
}
