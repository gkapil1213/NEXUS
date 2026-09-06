import { randomUUID } from 'crypto';
export function processCapacityApproval(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return { id, idempotencyKey: input.idempotencyKey || id, planId: input.planId, approver: input.approver || null, decision: input.decision || 'pending', approvedAt: input.approvedAt || null };
}
