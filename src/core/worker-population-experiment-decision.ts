export type ExperimentDecision = 'CONTINUE' | 'PROMOTE' | 'HOLD' | 'REJECT' | 'ROLLBACK' | 'RETIRE' | 'PAUSE';

export interface DecisionInput {
  confidence: number;
  evidenceLevel: 'PARTIAL' | 'SUFFICIENT' | 'INSUFFICIENT' | 'CONFLICTING' | 'DURABLE' | 'TRANSIENT' | 'REGRESSION' | 'FAILURE';
  regression: boolean;
  safetyAllowed: boolean;
  governanceAllowed: boolean;
  budgetExceeded: boolean;
  fatigueExcessive: boolean;
}

export function makeExperimentDecision(input: DecisionInput): ExperimentDecision {
  if (input.regression) return 'ROLLBACK';
  if (!input.safetyAllowed || !input.governanceAllowed) return 'REJECT';
  if (input.budgetExceeded || input.fatigueExcessive) return 'HOLD';
  if (input.evidenceLevel === 'INSUFFICIENT') return 'HOLD';
  if (input.evidenceLevel === 'CONFLICTING') return 'PAUSE';
  if (input.evidenceLevel === 'FAILURE') return 'REJECT';
  if (input.evidenceLevel === 'DURABLE' && input.confidence >= 0.7) return 'PROMOTE';
  return 'CONTINUE';
}
