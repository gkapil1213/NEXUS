export interface TransferAssessmentInput {
  sourcePopulationId: string;
  targetPopulationId: string;
  sourceStrategyId: string;
  contextCompatibility: number; // 0-1
  evidenceAvailable: boolean;
  confidence: number;
  safetyValidated: boolean;
  governanceAuthorized: boolean;
}

export function assessLearningTransfer(input: TransferAssessmentInput): { approved: boolean; reason: string } {
  if (!input.evidenceAvailable) return { approved: false, reason: 'missing evidence' };
  if (!input.safetyValidated) return { approved: false, reason: 'safety not validated' };
  if (!input.governanceAuthorized) return { approved: false, reason: 'governance not authorized' };
  if (input.contextCompatibility < 0.5) return { approved: false, reason: 'context incompatible' };
  if (input.confidence < 0.5) return { approved: false, reason: 'low confidence' };
  return { approved: true, reason: 'OK' };
}
