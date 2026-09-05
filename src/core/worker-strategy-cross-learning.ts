export interface CrossStrategyKnowledge {
  reusableImprovements: string[];
  reusableFailurePatterns: string[];
  commonResourceBottlenecks: string[];
  commonReliabilityPatterns: string[];
  strategySynergies: string[];
  strategyConflicts: string[];
}

export function transferKnowledge(
  source: CrossStrategyKnowledge,
  targetStrategyId: string,
  similarityScore: number,
  lineageMatch: boolean
): CrossStrategyKnowledge | null {
  if (!lineageMatch || similarityScore < 0.5) return null;
  return {
    reusableImprovements: source.reusableImprovements,
    reusableFailurePatterns: source.reusableFailurePatterns,
    commonResourceBottlenecks: source.commonResourceBottlenecks,
    commonReliabilityPatterns: source.commonReliabilityPatterns,
    strategySynergies: source.strategySynergies,
    strategyConflicts: source.strategyConflicts,
  };
}
