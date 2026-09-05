import { randomUUID } from 'crypto';

export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type FindingStatus = 'OPEN' | 'ACKNOWLEDGED' | 'REMEDIATION_PLANNED' | 'REMEDIATING' | 'RESOLVED' | 'REJECTED' | 'ACCEPTED_RISK' | 'UNKNOWN';

export interface SecurityFinding {
  findingId: string;
  assetId: string;
  source: string;
  category: string;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  description: string;
  evidence: string[];
  remediationGuidance: string;
  firstSeen: string;
  lastSeen: string;
  status: FindingStatus;
  fingerprint: string;
  references: string[];
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'REMEDIATION_PLANNED', 'ACCEPTED_RISK', 'REJECTED', 'UNKNOWN'],
  ACKNOWLEDGED: ['REMEDIATION_PLANNED', 'ACCEPTED_RISK', 'REJECTED'],
  REMEDIATION_PLANNED: ['REMEDIATING', 'REJECTED'],
  REMEDIATING: ['RESOLVED', 'UNKNOWN'],
  RESOLVED: [],
  REJECTED: [],
  ACCEPTED_RISK: [],
  UNKNOWN: ['OPEN', 'ACKNOWLEDGED'],
};

export function createSecurityFinding(
  input: Omit<SecurityFinding, 'findingId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): SecurityFinding {
  const fingerprint = `${input.source}:${input.category}:${input.assetId}:${input.title}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  const now = new Date().toISOString();
  return {
    findingId: randomUUID(),
    ...input,
    status: input.status ?? 'OPEN',
    fingerprint,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function transitionFinding(finding: SecurityFinding, next: FindingStatus): SecurityFinding {
  if (!VALID_TRANSITIONS[finding.status].includes(next)) {
    throw new Error(`Illegal finding transition from ${finding.status} to ${next}`);
  }
  return { ...finding, status: next, updatedAt: new Date().toISOString() };
}
