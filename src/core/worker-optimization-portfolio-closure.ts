export type PortfolioClosureDecision = 'PROMOTED' | 'REJECTED' | 'ROLLED_BACK' | 'DEFERRED' | 'ABORTED' | 'INSUFFICIENT_EVIDENCE';

export interface PortfolioClosureInput {
  allExperimentsSucceeded: boolean;
  anyCriticalRegression: boolean;
  insufficientEvidence: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
}

export function closePortfolio(input: PortfolioClosureInput): PortfolioClosureDecision {
  if (input.anyCriticalRegression) return 'ROLLED_BACK';
  if (!input.governanceAllowed || !input.safetyAllowed) return 'REJECTED';
  if (input.insufficientEvidence) return 'INSUFFICIENT_EVIDENCE';
  if (input.allExperimentsSucceeded) return 'PROMOTED';
  return 'DEFERRED';
}
