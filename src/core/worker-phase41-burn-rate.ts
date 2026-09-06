import { randomUUID } from 'crypto';
export function processBurnRate(input: any): any {
  const rate = input.rate || 0;
  let classification = 'normal';
  if (rate >= 10) classification = 'critical';
  else if (rate >= 5) classification = 'fast';
  else if (rate >= 2) classification = 'elevated';
  return { id: randomUUID(), serviceId: input.serviceId, rate, classification };
}
