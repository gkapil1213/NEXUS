import { randomUUID } from 'crypto';
export function processTrend(input: any): any {
  let direction = 'stable';
  if (input.direction) direction = input.direction;
  return { id: randomUUID(), serviceId: input.serviceId, metricType: input.metricType, direction, slope: input.slope || 0, acceleration: input.acceleration || 0, persistence: input.persistence || 0, confidence: input.confidence || 0, observationWindow: input.observationWindow || null };
}
