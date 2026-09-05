import { randomUUID } from 'crypto';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'REVOKED' | 'SUPERSEDED';

export interface ApprovalRequest {
  approvalRequestId: string;
  requestFingerprint: string;
  action: string;
  target: string;
  riskLevel: string;
  policyVersion: number;
  policyFingerprint: string;
  requiredApprovals: number;
  minApprovers: number;
  separateDuties: boolean;
  requesterId: string;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  approvals: { actorId: string; role: string; timestamp: string }[];
  idempotencyKey: string;
}

export function createApprovalRequest(
  input: Omit<ApprovalRequest, 'approvalRequestId' | 'createdAt' | 'status' | 'approvals' | 'idempotencyKey'> & { idempotencyKey?: string }
): ApprovalRequest {
  const idempotencyKey = input.idempotencyKey ?? input.requestFingerprint;
  return {
    approvalRequestId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    status: 'PENDING',
    approvals: [],
    idempotencyKey,
  };
}

export function approveRequest(request: ApprovalRequest, actor: { actorId: string; role: string }, separateDuties: boolean): { request: ApprovalRequest; success: boolean; reason: string } {
  if (request.status !== 'PENDING') return { request, success: false, reason: `request is ${request.status}` };
  if (separateDuties && actor.actorId === request.requesterId) return { request, success: false, reason: 'separation of duties violation' };
  if (request.approvals.some(a => a.actorId === actor.actorId)) return { request, success: false, reason: 'duplicate approval' };
  const newApprovals = [...request.approvals, { actorId: actor.actorId, role: actor.role, timestamp: new Date().toISOString() }];
  const newRequest: ApprovalRequest = { ...request, approvals: newApprovals };
  if (newApprovals.length >= request.minApprovers) {
    newRequest.status = 'APPROVED';
  }
  return { request: newRequest, success: true, reason: 'OK' };
}

export function rejectRequest(request: ApprovalRequest): ApprovalRequest {
  return { ...request, status: 'REJECTED' };
}

export function expireRequest(request: ApprovalRequest): ApprovalRequest {
  return { ...request, status: 'EXPIRED' };
}

export function isApprovalValid(request: ApprovalRequest): boolean {
  if (request.status !== 'APPROVED') return false;
  if (request.expiresAt && new Date(request.expiresAt) < new Date()) return false;
  return true;
}
