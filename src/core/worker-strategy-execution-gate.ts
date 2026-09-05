export type GateDecision = 'ALLOW' | 'BLOCK' | 'PAUSE' | 'REQUIRE_APPROVAL';

export interface GateInput {
  strategyExists: boolean;
  strategyApproved: boolean;
  confidenceSufficient: boolean;
  riskAllowed: boolean;
  constraintsSatisfied: boolean;
  resourceAvailable: boolean;
  noConflictingStrategy: boolean;
  noActiveRollbackLock: boolean;
  validLineage: boolean;
  requiredVerificationExists: boolean;
  requiredApprovalExists: boolean;
  duplicateExecution: boolean;
}

export function evaluateExecutionGate(input: GateInput): { decision: GateDecision; reason: string } {
  if (input.duplicateExecution) return { decision: 'BLOCK', reason: 'duplicate execution' };
  if (!input.strategyExists) return { decision: 'BLOCK', reason: 'strategy does not exist' };
  if (!input.strategyApproved) return { decision: 'BLOCK', reason: 'strategy not approved' };
  if (!input.validLineage) return { decision: 'BLOCK', reason: 'invalid strategy lineage' };
  if (!input.requiredVerificationExists || !input.requiredApprovalExists) {
    return { decision: 'REQUIRE_APPROVAL', reason: 'missing required verification or approval' };
  }
  if (!input.noActiveRollbackLock) return { decision: 'PAUSE', reason: 'active rollback lock' };
  if (!input.confidenceSufficient) return { decision: 'PAUSE', reason: 'insufficient confidence' };
  if (!input.riskAllowed) return { decision: 'BLOCK', reason: 'risk level not allowed' };
  if (!input.constraintsSatisfied) return { decision: 'BLOCK', reason: 'constraints not satisfied' };
  if (!input.resourceAvailable) return { decision: 'PAUSE', reason: 'resource not available' };
  if (!input.noConflictingStrategy) return { decision: 'BLOCK', reason: 'conflicting strategy active' };
  return { decision: 'ALLOW', reason: 'all gates passed' };
}