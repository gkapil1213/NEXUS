import { randomUUID } from 'crypto';

export type ReleaseCandidateStatus = 'CREATED' | 'VALIDATED' | 'APPROVED' | 'PROMOTING' | 'PROMOTED' | 'REJECTED' | 'BLOCKED' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface ReleaseCandidate {
  releaseCandidateId: string;
  artifactId: string;
  sourceRevision: string;
  pipelineExecutionId: string;
  version: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approvalState: 'PENDING' | 'APPROVED' | 'REJECTED';
  safetyState: 'PENDING' | 'ALLOW' | 'DENY';
  governanceState: 'PENDING' | 'ALLOW' | 'DENY';
  status: ReleaseCandidateStatus;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<ReleaseCandidateStatus, ReleaseCandidateStatus[]> = {
  CREATED: ['VALIDATED', 'CANCELLED'],
  VALIDATED: ['APPROVED', 'REJECTED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['PROMOTING', 'CANCELLED'],
  PROMOTING: ['PROMOTED', 'FAILED', 'ROLLED_BACK'],
  PROMOTED: ['ROLLED_BACK'],
  REJECTED: [],
  BLOCKED: [],
  FAILED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function createReleaseCandidate(
  input: Omit<ReleaseCandidate, 'releaseCandidateId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): ReleaseCandidate {
  const idempotencyKey = input.idempotencyKey ?? `${input.artifactId}:${input.version}:${input.sourceRevision}`;
  const now = new Date().toISOString();
  return {
    releaseCandidateId: randomUUID(),
    ...input,
    status: 'CREATED',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionReleaseCandidate(rc: ReleaseCandidate, next: ReleaseCandidateStatus): ReleaseCandidate {
  if (!VALID_TRANSITIONS[rc.status].includes(next)) {
    throw new Error(`Illegal release candidate transition from ${rc.status} to ${next}`);
  }
  return { ...rc, status: next, updatedAt: new Date().toISOString() };
}
