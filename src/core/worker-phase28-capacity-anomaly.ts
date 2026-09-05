export interface CapacityAnomaly {
  anomalyId: string;
  resourceId: string;
  metric: string;
  baseline: number;
  deviation: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: number;
  createdAt: string;
}

export function detectCapacityAnomaly(input: { baseline: number; observed: number; threshold: number }): { detected: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; deviation: number } {
  const deviation = Math.abs(input.observed - input.baseline) / Math.max(input.baseline, 1);
  if (deviation < input.threshold) return { detected: false, severity: 'LOW', deviation };
  const severity = deviation > 0.5 ? 'CRITICAL' : deviation > 0.2 ? 'HIGH' : 'MEDIUM';
  return { detected: true, severity, deviation };
}
