export interface MultiStrategyExperimentResult {
  winner?: string;
  nonDominated: string[];
  indistinguishable: string[];
  unsafe: string[];
  insufficientEvidence: string[];
  conflicting: string[];
}

export interface MultiStrategyInput {
  strategyIds: string[];
  metrics: Record<string, Record<string, number>>; // strategy -> dimension -> value
  dimensions: string[];
  confidence: Record<string, number>;
  regression: Record<string, boolean>;
  safetyAllowed: Record<string, boolean>;
}

export function evaluateMultiStrategyExperiment(input: MultiStrategyInput): MultiStrategyExperimentResult {
  const result: MultiStrategyExperimentResult = { nonDominated: [], indistinguishable: [], unsafe: [], insufficientEvidence: [], conflicting: [] };
  const eligible = input.strategyIds.filter(id => input.safetyAllowed[id] && !input.regression[id] && input.confidence[id] >= 0.3);
  if (eligible.length === 0) return result;
  for (const id of eligible) {
    if (input.confidence[id] < 0.5) {
      result.insufficientEvidence.push(id);
      continue;
    }
  }
  const dominated = new Set<string>();
  for (const a of eligible) {
    for (const b of eligible) {
      if (a === b) continue;
      let bBetter = true;
      let strictly = false;
      for (const dim of input.dimensions) {
        const av = input.metrics[a][dim] ?? 0;
        const bv = input.metrics[b][dim] ?? 0;
        if (bv < av) { bBetter = false; break; }
        if (bv > av) strictly = true;
      }
      if (bBetter && strictly) dominated.add(a);
    }
  }
  const nonDominated = eligible.filter(id => !dominated.has(id) && input.confidence[id] >= 0.5);
  result.nonDominated = nonDominated;
  result.winner = nonDominated.length === 1 ? nonDominated[0] : undefined;
  return result;
}
