export interface ChampionChallengerExperimentInput {
  championStrategyId: string;
  challengerStrategyId: string;
  championProtected: boolean;
  challengerEvidenceCount: number;
  challengerConfidence: number;
  requiredEvidence: number;
  confidenceThreshold: number;
  regressionDetected: boolean;
  safetyAllowed: boolean;
  governanceAllowed: boolean;
  rollbackAvailable: boolean;
}

export function evaluateChampionChallengerExperiment(input: ChampionChallengerExperimentInput): 'ALLOW_CHALLENGE' | 'KEEP_CHAMPION' | 'REJECT' {
  if (input.regressionDetected) return 'REJECT';
  if (!input.safetyAllowed || !input.governanceAllowed || !input.rollbackAvailable) return 'KEEP_CHAMPION';
  if (input.championProtected) return 'KEEP_CHAMPION';
  if (input.challengerEvidenceCount >= input.requiredEvidence && input.challengerConfidence >= input.confidenceThreshold) {
    return 'ALLOW_CHALLENGE';
  }
  return 'KEEP_CHAMPION';
}
