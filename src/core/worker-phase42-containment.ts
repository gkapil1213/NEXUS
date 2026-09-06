import { randomUUID } from 'crypto';
export function processContainment(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return { id, idempotencyKey: input.idempotencyKey || id, incidentId: input.incidentId, assetId: input.assetId, containmentType: input.containmentType || 'isolate', authorization: input.authorization || null, state: input.state || 'pending', executionId: input.executionId || null, rollbackCapability: input.rollbackCapability || null };
}
