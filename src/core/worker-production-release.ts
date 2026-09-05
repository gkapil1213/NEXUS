import { randomUUID } from 'crypto';

export type ReleaseStatus = 'CREATED' | 'VALIDATED' | 'APPROVED' | 'READY' | 'DEPLOYING' | 'DEPLOYED' | 'VERIFYING' | 'HEALTHY' | 'PROMOTED' | 'FAILED' | 'BLOCKED' | 'ROLLED_BACK' | 'CANCELLED' | 'EXPIRED';

export interface ProductionRelease {
  releaseId: string;
  artifactId: string;
  version: string;
  sourceCommit: string;
  buildId: string;
  environmentId: string;
  status: ReleaseStatus;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<ReleaseStatus, ReleaseStatus[]> = {
  CREATED: ['VALIDATED', 'CANCELLED'],
  VALIDATED: ['APPROVED', 'BLOCKED', 'CANCELLED'],
  APPROVED: ['READY', 'CANCELLED'],
  READY: ['DEPLOYING', 'EXPIRED'],
  DEPLOYING: ['DEPLOYED', 'FAILED'],
  DEPLOYED: ['VERIFYING', 'ROLLED_BACK'],
  VERIFYING: ['HEALTHY', 'FAILED', 'ROLLED_BACK'],
  HEALTHY: ['PROMOTED', 'ROLLED_BACK'],
  PROMOTED: [],
  FAILED: ['ROLLED_BACK', 'CANCELLED'],
  BLOCKED: ['CANCELLED'],
  ROLLED_BACK: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function createProductionRelease(
  input: Omit<ProductionRelease, 'releaseId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): ProductionRelease {
  const idempotencyKey = input.idempotencyKey ?? `${input.artifactId}:${input.version}:${input.environmentId}`;
  const now = new Date().toISOString();
  return {
    releaseId: randomUUID(),
    ...input,
    status: 'CREATED',
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionRelease(release: ProductionRelease, next: ReleaseStatus): ProductionRelease {
  if (!VALID_TRANSITIONS[release.status].includes(next)) {
    throw new Error(`Illegal release transition from ${release.status} to ${next}`);
  }
  return { ...release, status: next, updatedAt: new Date().toISOString() };
}
