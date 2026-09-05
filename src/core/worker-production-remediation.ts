import { randomUUID } from 'crypto';

export type RemediationStatus = 'PROPOSED' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';

export interface RemediationAction {
  remediationId: string;
  incidentId: string;
  actionType: 'ROLLBACK' | 'RESTART' | 'PAUSE_ROLLOUT' | 'SCALE' | 'DISABLE_FEATURE' | 'QUARANTINE' | 'RECOVER';
  environmentId: string;
  target: string;
  governanceApproved: boolean;
  safetyApproved: boolean;
  status: RemediationStatus;
  attemptCount: number;
  maxAttempts: number;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createRemediationAction(
  input: Omit<RemediationAction, 'remediationId' | 'createdAt' | 'updatedAt' | 'status' | 'attemptCount' | 'idempotencyKey'> & { idempotencyKey?: string; attemptCount?: number }
): RemediationAction {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.actionType}:${input.target}`;
  const now = new Date().toISOString();
  return {
    remediationId: randomUUID(),
    ...input,
    status: 'PROPOSED',
    attemptCount: input.attemptCount ?? 0,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function canRetryRemediation(action: RemediationAction): boolean {
  return action.status === 'FAILED' && action.attemptCount < action.maxAttempts;
}
