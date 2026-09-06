import { randomUUID } from 'crypto';
export function processRecoveryPriority(input: any): any {
  return {
    id: randomUUID(),
    assetId: input.assetId,
    priority: input.priority || 0,
    reason: input.reason || null,
  };
}
