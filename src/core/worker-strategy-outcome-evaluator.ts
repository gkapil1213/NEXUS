export type OutcomeClassification = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'NEUTRAL' | 'FAILURE' | 'REGRESSION' | 'INCONCLUSIVE';

export interface OutcomeEvaluationInput {
  expectedMetrics: Record<string, number>;
  observedMetrics: Record<string, number>;
  sampleSize: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  evaluationWindowDays: number;
  statisticalSufficiency: boolean;
  causalityConfidence: number; // 0-1
}

export function evaluateOutcome(input: OutcomeEvaluationInput): OutcomeClassification {
  if (!input.statisticalSufficiency || input.sampleSize < 10) return 'INCONCLUSIVE';
  if (input.causalityConfidence < 0.5) return 'INCONCLUSIVE';
  const totalImprovement = Object.keys(input.expectedMetrics).reduce((sum, key) => {
    const exp = input.expectedMetrics[key];
    const obs = input.observedMetrics[key] ?? exp;
    return sum + (obs - exp);
  }, 0);
  if (totalImprovement > 0) return input.confidence === 'HIGH' ? 'SUCCESS' : 'PARTIAL_SUCCESS';
  if (totalImprovement === 0) return 'NEUTRAL';
  if (totalImprovement < -0.5) return 'REGRESSION';
  return 'FAILURE';
}