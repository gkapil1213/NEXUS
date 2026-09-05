export interface ExecutionRiskInput {
  strategyRisk: number;
  portfolioRisk: number;
  concentration: number;
  correlatedFailure: number;
  resourceExhaustion: number;
  blastRadius: number;
  cumulativeDegradation: number;
  rollbackAvailable: boolean;
}

export function evaluateExecutionRisk(input: ExecutionRiskInput): { riskScore: number; allowed: boolean; reason: string } {
  const score = input.strategyRisk * 0.25 + input.portfolioRisk * 0.2 + input.concentration * 0.1 + input.correlatedFailure * 0.15 + input.resourceExhaustion * 0.1 + input.blastRadius * 0.1 + input.cumulativeDegradation * 0.1;
  const allowed = input.rollbackAvailable && score < 0.7;
  return { riskScore: score, allowed, reason: allowed ? 'OK' : 'risk exceeds threshold' };
}
