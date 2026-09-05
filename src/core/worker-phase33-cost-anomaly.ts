export interface CostAnomaly {
  anomalyId: string;
  resourceId: string;
  expectedCost: number;
  actualCost: number;
  deviation: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function detectCostAnomaly(input: { expectedCost: number; actualCost: number; threshold: number }): { detected: boolean; deviation: number; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } {
  const deviation = (input.actualCost - input.expectedCost) / Math.max(input.expectedCost, 1);
  if (deviation < input.threshold) return { detected: false, deviation, severity: 'LOW' };
  const severity = deviation > 0.5 ? 'CRITICAL' : deviation > 0.2 ? 'HIGH' : 'MEDIUM';
  return { detected: true, deviation, severity };
}
