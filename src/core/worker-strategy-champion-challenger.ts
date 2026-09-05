export interface ChampionChallengerState {
  championStrategyId: string;
  challengerStrategyIds: string[];
  championProtected: boolean;
  lastPromotionTimestamp?: string;
  requiredEvidenceCount: number;
  currentEvidenceCount: number;
}

export type ChampionDecision = 'KEEP_CHAMPION' | 'ALLOW_CHALLENGE' | 'PROMOTE_CHALLENGER';

export interface ChampionChallengerInput {
  champion: ChampionChallengerState;
  challengerEvidence: { strategyId: string; evidenceCount: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'; regressionFree: boolean }[];
  governanceApproved: boolean;
  safetyApproved: boolean;
  rollbackAvailable: boolean;
}

export function evaluateChampionChallenger(input: ChampionChallengerInput): ChampionDecision {
  if (!input.governanceApproved || !input.safetyApproved || !input.rollbackAvailable) return 'KEEP_CHAMPION';
  // Find best eligible challenger
  const eligible = input.challengerEvidence
    .filter(c => c.evidenceCount >= input.champion.requiredEvidenceCount && c.regressionFree && c.confidence !== 'LOW' && c.confidence !== 'UNKNOWN')
    .sort((a, b) => b.evidenceCount - a.evidenceCount);
  if (eligible.length === 0) return 'KEEP_CHAMPION';
  return 'PROMOTE_CHALLENGER';
}
