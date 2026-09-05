export interface AccessDecisionRecord {
  decisionId: string;
  requestId: string;
  decision: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'BLOCKED' | 'UNKNOWN';
  reason: string;
  risk: string;
  policyIds: string[];
  timestamp: string;
  idempotencyKey: string;
}

export function createAccessDecisionRecord(input: Omit<AccessDecisionRecord, 'timestamp' | 'idempotencyKey' | 'decisionId'> & { idempotencyKey?: string }): AccessDecisionRecord {
  const idempotencyKey = input.idempotencyKey ?? input.requestId;
  return { decisionId: `decision-${Date.now()}`, ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
