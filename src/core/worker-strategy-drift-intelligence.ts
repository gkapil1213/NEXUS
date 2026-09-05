export type DriftSeverity = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';

export interface DriftIntelligenceInput {
  baseline: Record<string, number>;
  recent: Record<string, number>;
  threshold: number;
  type: 'PERFORMANCE' | 'OBJECTIVE' | 'ENVIRONMENT' | 'RESOURCE_COST' | 'RISK' | 'RELIABILITY' | 'CONFIDENCE';
}

export function detectStrategyDrift(input: DriftIntelligenceInput): DriftSeverity {
  const keys = Object.keys(input.baseline);
  if (keys.length === 0) return 'HEALTHY';
  let maxDelta = 0;
  for (const key of keys) {
    const base = input.baseline[key];
    const rec = input.recent[key] ?? base;
    if (base === 0) continue;
    const delta = Math.abs((rec - base) / base);
    if (delta > maxDelta) maxDelta = delta;
  }
  if (maxDelta < input.threshold) return 'HEALTHY';
  if (maxDelta < input.threshold * 4) return 'WATCH';
  if (maxDelta < input.threshold * 10) return 'DEGRADED';
  return 'CRITICAL';
}
