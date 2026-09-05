export interface PortfolioConflictInput {
  populationIds: string[];
  targetOverlap: string[];
  objectiveConflicts: boolean;
  rolloutConflicts: boolean;
  resourceConflicts: boolean;
  safetyPolicyConflicts: boolean;
  governancePolicyConflicts: boolean;
}

export function detectPortfolioConflict(input: PortfolioConflictInput): { conflicted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.targetOverlap.length > 0) reasons.push('target overlap');
  if (input.objectiveConflicts) reasons.push('objective conflict');
  if (input.rolloutConflicts) reasons.push('rollout conflict');
  if (input.resourceConflicts) reasons.push('resource conflict');
  if (input.safetyPolicyConflicts) reasons.push('safety policy conflict');
  if (input.governancePolicyConflicts) reasons.push('governance policy conflict');
  return { conflicted: reasons.length > 0, reasons };
}
