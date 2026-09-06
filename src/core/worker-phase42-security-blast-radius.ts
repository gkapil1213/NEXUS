import { randomUUID } from 'crypto';
export function processSecurityBlastRadius(input: any): any {
  let classification = 'low';
  if (input.critical) classification = 'critical';
  else if (input.high) classification = 'high';
  else if (input.medium) classification = 'medium';
  return { id: randomUUID(), assetId: input.assetId, classification };
}
