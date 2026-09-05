import { randomUUID } from 'crypto';

export type DecisionClosureStatus =
  | 'PROMOTED'
  | 'ROLLED_BACK'
  | 'REJECTED'
  | 'EXPIRED'
  | 'INSUFFICIENT_DATA'
  | 'ABORTED_SAFETY'
  | 'ABORTED_REGRESSION'
  | 'DEFERRED';

export interface DecisionClosure {
  decisionId: string;
  experimentId: string;
  hypothesisId: string;
  tenantId: string;
  policyVersion: string;
  causalClassification: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  metricSummary: Record<string, number>;
  riskSummary: string;
  safetyDecision: string;
  governanceDecision: string;
  rolloutSummary: string;
  outcome: string;
  reason: string;
  correlationId: string;
  timestamp: string;
}

export function closeDecision(
  input: Omit<DecisionClosure, 'decisionId' | 'timestamp'>
): DecisionClosure {
  return {
    decisionId: randomUUID(),
    ...input,
    timestamp: new Date().toISOString(),
  };
}
