import { randomUUID } from 'crypto';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface ApprovalRequest {
  approvalId: string;
  requestId: string;
  approverRole: string;
  status: ApprovalStatus;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  requiredApprovals: number;
  currentApprovals: number;
  separationOfDuties: boolean;
  requesterId: string;
  idempotencyKey: string;
}

export function createApprovalRequest(input: Omit<ApprovalRequest, 'approvalId' | 'requestedAt' | 'status' | 'currentApprovals' | 'idempotencyKey'> & { idempotencyKey?: string }): ApprovalRequest {
  const idempotencyKey = input.idempotencyKey ?? input.requestId;
  return {
    approvalId: randomUUID(),
    ...input,
    requestedAt: new Date().toISOString(),
    status: 'PENDING',
    currentApprovals: 0,
    idempotencyKey,
  };
}

export function isValidApproval(approval: ApprovalRequest): boolean {
  return approval.status === 'APPROVED' && new Date(approval.expiresAt) > new Date();
}
