import { randomUUID } from 'crypto';
export function processEscalation(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return { id, idempotencyKey: input.idempotencyKey || id, incidentId: input.incidentId, level: input.level || 'high', reason: input.reason || '', target: input.target || null };
}
