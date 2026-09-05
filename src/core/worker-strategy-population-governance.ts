export type PopulationGovernanceAction =
  | 'CREATE_POPULATION_VERSION'
  | 'ADD_STRATEGY'
  | 'PROMOTE_STRATEGY'
  | 'DEMOTE_STRATEGY'
  | 'RETIRE_STRATEGY'
  | 'RESTORE_STRATEGY'
  | 'REPLACE_CHAMPION'
  | 'PRESERVE_SPECIALIST'
  | 'REJECT_CANDIDATE';

export interface PopulationGovernanceInput {
  action: PopulationGovernanceAction;
  tenantId: string;
  populationId: string;
  strategyId?: string;
  targetStrategyId?: string;
  governanceApproved: boolean;
  safetyApproved: boolean;
  approvalRequired: boolean;
  rollbackAvailable: boolean;
  resourceAvailable: boolean;
  evidenceSufficient: boolean;
}

export function governPopulationAction(input: PopulationGovernanceInput): { allowed: boolean; reason: string } {
  if (!input.governanceApproved) return { allowed: false, reason: 'governance not approved' };
  if (!input.safetyApproved) return { allowed: false, reason: 'safety not approved' };
  if (input.approvalRequired) return { allowed: false, reason: 'additional approval required' };
  if (!input.resourceAvailable) return { allowed: false, reason: 'resource not available' };
  if (!input.evidenceSufficient) return { allowed: false, reason: 'insufficient evidence' };
  if (input.action === 'REPLACE_CHAMPION' || input.action === 'RETIRE_STRATEGY' || input.action === 'PROMOTE_STRATEGY') {
    if (!input.rollbackAvailable) return { allowed: false, reason: 'rollback unavailable' };
  }
  return { allowed: true, reason: 'OK' };
}
