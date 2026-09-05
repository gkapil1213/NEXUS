export interface PortfolioRiskInput {
  individualRisks: number[];
  correlation: number;
  blastRadius: number;
}

export function calculatePortfolioRisk(input: PortfolioRiskInput): number {
  if (input.individualRisks.length === 0) return 0;
  const avg = input.individualRisks.reduce((s,v)=>s+v,0)/input.individualRisks.length;
  return Math.min(1, avg + input.correlation * 0.5 + input.blastRadius * 0.3);
}
