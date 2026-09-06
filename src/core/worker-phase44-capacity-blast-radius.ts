import { randomUUID } from 'crypto';
export function processCapacityBlastRadius(input: any): any {
  let classification = 'low';
  if (input.critical) classification = 'critical';
  else if (input.high) classification = 'high';
  else if (input.medium) classification = 'medium';
  return { id: randomUUID(), resourceId: input.resourceId, classification };
}
