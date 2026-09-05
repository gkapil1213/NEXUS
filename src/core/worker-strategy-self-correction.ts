export type SelfCorrectionAction = 'KEEP' | 'REDUCE_ROLLOUT' | 'PAUSE' | 'REEVALUATE' | 'LOWER_CONFIDENCE' | 'ADAPT' | 'ROLLBACK' | 'RETIRE';

export interface SelfCorrectionInput {
  driftSeverity: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';
  effectiveness: number; // 0-1
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  regressionDetected: boolean;
  resourceBudgetExceeded: boolean;
  governanceAllowed: boolean;
  safetyAllowed: boolean;
  approvalRequired: boolean;
}

export function determineSelfCorrection(input: SelfCorrectionInput): SelfCorrectionAction {
  if (!input.governanceAllowed || !input.safetyAllowed) return 'PAUSE';
  if (input.driftSeverity === 'CRITICAL' || input.regressionDetected || input.resourceBudgetExceeded) return 'ROLLBACK';
  if (input.driftSeverity === 'DEGRADED') return input.approvalRequired ? 'REEVALUATE' : 'ADAPT';
  if (input.driftSeverity === 'WATCH') return 'KEEP';
  if (input.effectiveness < 0.3) return 'RETIRE';
  if (input.confidence === 'LOW' || input.confidence === 'UNKNOWN') return 'LOWER_CONFIDENCE';
  return 'KEEP';
}
