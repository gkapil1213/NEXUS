export interface AdaptationGateInput {
  evidenceSufficient: boolean;
  confidence: number;
  regressionDetected: boolean;
  safetyApproved: boolean;
  governanceApproved: boolean;
  budgetCompatible: boolean;
  diversityConstraints: boolean;
  rollbackAvailable: boolean;
}

export function evaluateAdaptationGate(input: AdaptationGateInput): { allowed: boolean; reason: string } {
  if (!input.evidenceSufficient) return { allowed: false, reason: 'insufficient evidence' };
  if (input.confidence < 0.5) return { allowed: false, reason: 'low confidence' };
  if (input.regressionDetected) return { allowed: false, reason: 'regression' };
  if (!input.safetyApproved) return { allowed: false, reason: 'safety not approved' };
  if (!input.governanceApproved) return { allowed: false, reason: 'governance not approved' };
  if (!input.budgetCompatible) return { allowed: false, reason: 'budget incompatible' };
  if (!input.diversityConstraints) return { allowed: false, reason: 'diversity constraint' };
  if (!input.rollbackAvailable) return { allowed: false, reason: 'rollback unavailable' };
  return { allowed: true, reason: 'OK' };
}
