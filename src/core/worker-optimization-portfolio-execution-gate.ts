export type GateDecision = 'ALLOW' | 'BLOCK' | 'PAUSE';

export interface ExecutionGateInput {
  portfolioApproved: boolean;
  portfolioVersionValid: boolean;
  strategyCandidatesValid: boolean;
  strategyStatusPermits: boolean;
  constraintsPass: boolean;
  riskLimitsPass: boolean;
  budgetAvailable: boolean;
  requiredEvidenceExists: boolean;
  governanceApproved: boolean;
  noConflictingExecution: boolean;
  noActiveRollback: boolean;
  noSafetyIncident: boolean;
}

export function evaluateExecutionGate(input: ExecutionGateInput): { decision: GateDecision; reason: string } {
  if (!input.portfolioApproved) return { decision: 'BLOCK', reason: 'portfolio not approved' };
  if (!input.portfolioVersionValid) return { decision: 'BLOCK', reason: 'invalid version' };
  if (!input.strategyCandidatesValid) return { decision: 'BLOCK', reason: 'invalid strategy candidates' };
  if (!input.strategyStatusPermits) return { decision: 'BLOCK', reason: 'strategy status does not permit' };
  if (!input.constraintsPass) return { decision: 'BLOCK', reason: 'constraints failed' };
  if (!input.riskLimitsPass) return { decision: 'BLOCK', reason: 'risk limit exceeded' };
  if (!input.budgetAvailable) return { decision: 'BLOCK', reason: 'budget unavailable' };
  if (!input.requiredEvidenceExists) return { decision: 'BLOCK', reason: 'missing evidence' };
  if (!input.governanceApproved) return { decision: 'BLOCK', reason: 'governance not approved' };
  if (!input.noConflictingExecution) return { decision: 'BLOCK', reason: 'conflicting execution' };
  if (!input.noActiveRollback) return { decision: 'BLOCK', reason: 'active rollback' };
  if (!input.noSafetyIncident) return { decision: 'BLOCK', reason: 'safety incident' };
  return { decision: 'ALLOW', reason: 'OK' };
}
