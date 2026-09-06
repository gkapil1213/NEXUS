import { randomUUID } from 'crypto';
export function processPromotion(input: any): any {
  if (input.health === 'UNKNOWN') return { id: randomUUID(), decision: 'HOLD' };
  if (input.health === 'UNHEALTHY') return { id: randomUUID(), decision: 'HALT' };
  return { id: randomUUID(), decision: 'PROMOTE' };
}
