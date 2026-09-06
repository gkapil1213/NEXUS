import { randomUUID } from 'crypto';
export function processReliabilityAnomaly(input: any): any {
  const severity = input.critical ? 'critical' : (input.warning ? 'warning' : 'normal');
  return { id: randomUUID(), serviceId: input.serviceId, type: input.type || 'generic', severity };
}
