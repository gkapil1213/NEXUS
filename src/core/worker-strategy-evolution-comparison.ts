export interface ComparisonResult {
  parentGenerationId: string;
  candidateId: string;
  objectiveDelta: Record<string, number>;
  regression: boolean;
  confidenceDelta: number;
  riskDelta: number;
  overallDecision: 'IMPROVED' | 'NEUTRAL' | 'DEGRADED' | 'UNKNOWN';
}

export function compareGenerations(
  parentMetrics: Record<string, number>,
  candidateMetrics: Record<string, number>,
  confidenceParent: number,
  confidenceCandidate: number,
  riskParent: number,
  riskCandidate: number
): ComparisonResult {
  const delta: Record<string, number> = {};
  let positive = 0, negative = 0;
  for (const key of Object.keys(parentMetrics)) {
    const d = candidateMetrics[key] - parentMetrics[key];
    delta[key] = d;
    if (d > 0) positive++;
    else if (d < 0) negative++;
  }
  const regression = negative > 0;
  const confidenceDelta = confidenceCandidate - confidenceParent;
  const riskDelta = riskCandidate - riskParent;
  let overall: 'IMPROVED' | 'NEUTRAL' | 'DEGRADED' | 'UNKNOWN' = 'UNKNOWN';
  if (regression) overall = 'DEGRADED';
  else if (positive > 0 && negative === 0) overall = 'IMPROVED';
  else if (positive === 0 && negative === 0) overall = 'NEUTRAL';
  return {
    parentGenerationId: '',
    candidateId: '',
    objectiveDelta: delta,
    regression,
    confidenceDelta,
    riskDelta,
    overallDecision: overall,
  };
}
