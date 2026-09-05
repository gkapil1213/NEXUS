export type PortfolioRolloutStage = 'OBSERVE_ONLY' | 'CANARY' | 'LIMITED' | 'PROGRESSIVE' | 'FULL' | 'HOLD' | 'PORTFOLIO_HOLD' | 'ROLLBACK_AFFECTED' | 'ROLLBACK_PORTFOLIO';

export interface PortfolioRolloutInput {
  currentStage: PortfolioRolloutStage;
  experimentHealth: { criticalRegression: boolean; anyRegression: boolean; safetyCompromised: boolean }[];
  thresholds: { criticalErrorRate: number; maxRegressionRatio: number };
}

export function evaluatePortfolioRollout(input: PortfolioRolloutInput): PortfolioRolloutStage {
  const critical = input.experimentHealth.some(e => e.criticalRegression || e.safetyCompromised);
  if (critical) return 'ROLLBACK_PORTFOLIO';
  const regressions = input.experimentHealth.filter(e => e.anyRegression).length;
  const ratio = regressions / Math.max(input.experimentHealth.length, 1);
  if (ratio >= input.thresholds.maxRegressionRatio) return 'PORTFOLIO_HOLD';
  if (input.currentStage === 'FULL') return 'FULL';
  const order: PortfolioRolloutStage[] = ['OBSERVE_ONLY', 'CANARY', 'LIMITED', 'PROGRESSIVE', 'FULL'];
  const idx = order.indexOf(input.currentStage);
  return idx < order.length - 1 ? order[idx + 1] : 'FULL';
}
