export type EvolutionGovernanceDecision = 'APPROVE' | 'REJECT' | 'REVIEW';

export interface EvolutionGovernanceInput {
  candidateRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  confidence: 'INSUFFICIENT_DATA' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  evidenceSufficient: boolean;
  regressionFree: boolean;
  requiredApproval: boolean;
  autonomyPermitted: boolean;
  freezeActive: boolean;
  budgetAvailable: boolean;
}

export function governEvolutionCandidate(input: EvolutionGovernanceInput): EvolutionGovernanceDecision {
  if (input.freezeActive) return 'REJECT';
  if (input.candidateRisk === 'CRITICAL' || input.candidateRisk === 'UNKNOWN') return 'REVIEW';
  if (input.confidence === 'INSUFFICIENT_DATA' || input.confidence === 'LOW') return 'REVIEW';
  if (!input.evidenceSufficient || !input.regressionFree) return 'REJECT';
  if (input.requiredApproval && !input.autonomyPermitted) return 'REVIEW';
  if (!input.budgetAvailable) return 'REJECT';
  return 'APPROVE';
}
