import { randomUUID } from 'crypto';
export function processRecoveryImpact(input: any): any {
  return { id: randomUUID(), assetId: input.assetId, affectedServices: input.affectedServices || [], businessImpact: input.businessImpact || null, customerImpact: input.customerImpact || null };
}
