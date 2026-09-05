export interface GovernanceLearningRecord {
  decisionId: string;
  expectedOutcome: string;
  actualOutcome: string;
  policyEffectiveness: string;
  falsePositive: boolean;
  falseNegative: boolean;
  remediationSuccess: boolean;
  rollbackSuccess: boolean;
  createdAt: string;
}

export function createGovernanceLearningRecord(input: Omit<GovernanceLearningRecord, 'createdAt'>): GovernanceLearningRecord {
  return { ...input, createdAt: new Date().toISOString() };
}
