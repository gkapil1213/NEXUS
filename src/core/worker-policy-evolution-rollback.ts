export type RollbackDecision = 'ALLOWED' | 'DENIED' | 'DEFERRED';

export interface RollbackInput {
  tenantId: string;
  policyId: string;
  currentVersion: string;
  previousKnownGoodVersion: string;
  trigger: 'RELIABILITY_REGRESSION' | 'ERROR_SPIKE' | 'LATENCY_VIOLATION' | 'INCIDENT' | 'SAFETY_VIOLATION' | 'COST_EXPLOSION' | 'POLICY_INSTABILITY' | 'REPEATED_FAILED_ROLLOUT';
  duplicateRollback: boolean;
  rollbackAuthorized: boolean;
  rollbackAvailable: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  activeIncident: boolean;
  productionFreeze: boolean;
}

export function evaluateRollback(input: RollbackInput): RollbackDecision {
  if (input.duplicateRollback) return 'DEFERRED'; // idempotency prevents duplicate, but return deferred
  if (!input.rollbackAuthorized || !input.rollbackAvailable) return 'DENIED';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'DENIED';
  if (input.activeIncident || input.productionFreeze) return 'DEFERRED';
  return 'ALLOWED';
}
