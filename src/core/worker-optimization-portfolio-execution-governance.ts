export type ExecutionGovernanceDecision = 'APPROVED' | 'DENIED' | 'REVIEW';

export interface ExecutionGovernanceInput {
  risk: number;
  confidence: number;
  evidenceSufficient: boolean;
  budgetAvailable: boolean;
  highRisk: boolean;
  approvalRequired: boolean;
}

export function governExecution(input: ExecutionGovernanceInput): ExecutionGovernanceDecision {
  if (!input.budgetAvailable || !input.evidenceSufficient) return 'DENIED';
  if (input.risk > 0.8) return 'DENIED';
  if (input.highRisk || input.approvalRequired || input.confidence < 0.5) return 'REVIEW';
  return 'APPROVED';
}
