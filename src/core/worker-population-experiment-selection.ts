export interface CandidateProfile {
  strategyId: string;
  fitness: number;
  confidence: number;
  uncertainty: number;
  historicalPerformance: number;
  recentFailures: number;
  strategyAge: number;
  generation: number;
  lineageId: string;
  diversityContribution: number;
  redundancyScore: number;
  paretoPosition: number;
  evolutionPressure: number;
  stagnationScore: number;
  risk: number;
}

export interface SelectionInput {
  candidates: CandidateProfile[];
  budgetRemaining: number;
  maxCandidates: number;
  fatigueScore: number;
}

export function selectExperimentCandidates(input: SelectionInput): string[] {
  if (input.candidates.length === 0) return [];
  // deterministic scoring: prefer higher fitness, diversity, lower redundancy/risk, penalize recent failures
  const scored = input.candidates.map(c => ({
    id: c.strategyId,
    score: c.fitness * 0.3 + c.confidence * 0.2 + c.diversityContribution * 0.15 + (1 - c.redundancyScore) * 0.1 + (1 - c.risk) * 0.15 - c.recentFailures * 0.1 - c.stagnationScore * 0.05,
  }));
  scored.sort((a,b) => b.score - a.score);
  const limit = Math.min(input.maxCandidates, scored.length);
  return scored.slice(0, limit).map(s => s.id);
}
