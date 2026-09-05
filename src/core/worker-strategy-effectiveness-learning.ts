export interface EffectivenessLearningResult {
  strategyId: string;
  successRate: number;
  regressionRate: number;
  expectedVsActual: number;
  durability: 'DURABLE' | 'TRANSIENT' | 'UNKNOWN';
  stability: 'STABLE' | 'UNSTABLE' | 'UNKNOWN';
  resourceEfficiency: number;
  riskAdjustedValue: number;
  repeatedFailurePattern: boolean;
  environmentSpecificPerformance: string[];
  updatedAt: string;
}

export function learnEffectiveness(
  strategyId: string,
  outcomes: {
    classification: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NEUTRAL' | 'REGRESSION' | 'SEVERE_REGRESSION';
    expected: number;
    actual: number;
    resourceCost: number;
    risk: number;
    environment: string;
    durability: 'DURABLE' | 'TRANSIENT' | 'UNKNOWN';
  }[]
): EffectivenessLearningResult {
  const total = outcomes.length;
  if (total === 0) {
    return {
      strategyId,
      successRate: 0,
      regressionRate: 0,
      expectedVsActual: 0,
      durability: 'UNKNOWN',
      stability: 'UNKNOWN',
      resourceEfficiency: 0,
      riskAdjustedValue: 0,
      repeatedFailurePattern: false,
      environmentSpecificPerformance: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const successes = outcomes.filter(o => o.classification === 'SUCCESS' || o.classification === 'PARTIAL_SUCCESS').length;
  const regressions = outcomes.filter(o => o.classification === 'REGRESSION' || o.classification === 'SEVERE_REGRESSION').length;
  const avgExpected = outcomes.reduce((s, o) => s + o.expected, 0) / total;
  const avgActual = outcomes.reduce((s, o) => s + o.actual, 0) / total;
  const expectedVsActual = avgActual - avgExpected;
  const avgResource = outcomes.reduce((s, o) => s + o.resourceCost, 0) / total;
  const avgRisk = outcomes.reduce((s, o) => s + o.risk, 0) / total;
  const resourceEfficiency = avgResource > 0 ? expectedVsActual / avgResource : 0;
  const riskAdjustedValue = expectedVsActual - avgRisk;
  const repeatedFailurePattern = regressions >= 2;
  const environments = [...new Set(outcomes.map(o => o.environment))];
  const durableCount = outcomes.filter(o => o.durability === 'DURABLE').length;
  const transientCount = outcomes.filter(o => o.durability === 'TRANSIENT').length;
  const durability = durableCount > transientCount ? 'DURABLE' : transientCount > durableCount ? 'TRANSIENT' : 'UNKNOWN';
  return {
    strategyId,
    successRate: successes / total,
    regressionRate: regressions / total,
    expectedVsActual,
    durability,
    stability: repeatedFailurePattern ? 'UNSTABLE' : 'STABLE',
    resourceEfficiency,
    riskAdjustedValue,
    repeatedFailurePattern,
    environmentSpecificPerformance: environments,
    updatedAt: new Date().toISOString(),
  };
}
