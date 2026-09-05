export type ConflictDecision = 'ALLOW' | 'DENY' | 'DEFER' | 'CONFLICTED' | 'OBSERVE_ONLY';

export interface ConflictInput {
  tenantId: string;
  policyId: string;
  sourceVersion: string;
  proposedVersion: string;
  activeProposals: {
    policyId: string;
    proposedVersion: string;
    status: string;
  }[];
  activeRecovery: boolean;
  activeRelease: boolean;
  activeOptimization: boolean;
  staleProposal: boolean;
  dependencyConflict: boolean;
  tenantScopeConflict: boolean;
}

export function detectPolicyEvolutionConflict(input: ConflictInput): ConflictDecision {
  if (input.staleProposal) return 'DEFER';
  if (input.tenantScopeConflict) return 'DENY';

  const hasConflictingProposal = input.activeProposals.some(
    (p) => p.policyId === input.policyId && p.proposedVersion !== input.proposedVersion
  );
  if (hasConflictingProposal) return 'CONFLICTED';

  if (input.activeRecovery) {
    return 'DENY'; // do not evolve policy during recovery
  }
  if (input.activeRelease) {
    return 'DEFER'; // wait for release to finish
  }
  if (input.activeOptimization) {
    return 'OBSERVE_ONLY'; // possibly conflicting, but lower priority
  }
  if (input.dependencyConflict) return 'DENY';

  return 'ALLOW';
}
