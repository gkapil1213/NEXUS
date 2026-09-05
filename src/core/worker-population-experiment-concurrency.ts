export interface ConcurrencyLimits {
  maxActiveExperiments: number;
  maxExperimentsPerStrategy: number;
  maxExperimentsPerLineage: number;
  maxExperimentsPerPopulation: number;
  maxConcurrentChallengers: number;
  maxPopulationMutations: number;
}

export interface ConcurrencyState {
  activeExperiments: number;
  experimentsPerStrategy: Record<string, number>;
  experimentsPerLineage: Record<string, number>;
  experimentsPerPopulation: number;
  concurrentChallengers: number;
  populationMutations: number;
}

export function checkConcurrency(
  limits: ConcurrencyLimits,
  state: ConcurrencyState,
  strategyId: string,
  lineageId: string
): { allowed: boolean; reason: string } {
  if (state.activeExperiments >= limits.maxActiveExperiments) return { allowed: false, reason: 'max active experiments reached' };
  if ((state.experimentsPerStrategy[strategyId] ?? 0) >= limits.maxExperimentsPerStrategy) return { allowed: false, reason: 'max experiments per strategy reached' };
  if ((state.experimentsPerLineage[lineageId] ?? 0) >= limits.maxExperimentsPerLineage) return { allowed: false, reason: 'max experiments per lineage reached' };
  if (state.experimentsPerPopulation >= limits.maxExperimentsPerPopulation) return { allowed: false, reason: 'max experiments per population reached' };
  if (state.concurrentChallengers >= limits.maxConcurrentChallengers) return { allowed: false, reason: 'max concurrent challengers reached' };
  if (state.populationMutations >= limits.maxPopulationMutations) return { allowed: false, reason: 'max population mutations reached' };
  return { allowed: true, reason: 'OK' };
}
