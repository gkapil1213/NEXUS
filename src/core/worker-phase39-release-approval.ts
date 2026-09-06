import { randomUUID } from 'crypto';
export function processReleaseApproval(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    releaseId: input.releaseId,
    approver: input.approver || null,
    decision: input.decision || 'PENDING',
    reason: input.reason || null,
    approvedAt: input.approvedAt || null,
    expiresAt: input.expiresAt || null,
  };
}
