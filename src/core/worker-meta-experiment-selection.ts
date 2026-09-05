export interface MetaMethodProfile {
  methodId: string;
  effectiveness: number;
  confidence: number;
  resourceEfficiency: number;
  regressionRate: number;
  rollbackRate: number;
  fatigueContribution: number;
  stagnationContribution: number;
}

export function selectMetaExperimentCandidates(profiles: MetaMethodProfile[], maxCandidates: number): string[] {
  if (profiles.length === 0) return [];
  const scored = profiles.map(p => ({
    id: p.methodId,
    score: p.effectiveness * 0.3 + p.confidence * 0.25 + p.resourceEfficiency * 0.2 - p.regressionRate * 0.1 - p.rollbackRate * 0.1 - p.fatigueContribution * 0.05 - p.stagnationContribution * 0.05,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(maxCandidates, scored.length)).map(s => s.id);
}
