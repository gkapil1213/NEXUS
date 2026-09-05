export type DriftType = 'PERFORMANCE' | 'OBJECTIVE' | 'CONSTRAINT' | 'RESOURCE' | 'RISK' | 'ENVIRONMENT' | 'OUTCOME';
export type DriftSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DriftInput {
  baseline: Record<string, number>;
  observed: Record<string, number>;
  threshold: number;
}

export function detectStrategyDrift(input: DriftInput, type: DriftType): { severity: DriftSeverity; recommendedAction: string } {
  const delta = averageDelta(input.baseline, input.observed);
  const absDelta = Math.abs(delta);
  if (absDelta < input.threshold) return { severity: 'NONE', recommendedAction: 'CONTINUE' };
  if (absDelta < input.threshold * 2) return { severity: 'LOW', recommendedAction: 'MONITOR' };
  if (absDelta < input.threshold * 5) return { severity: 'MEDIUM', recommendedAction: 'HOLD' };
  if (absDelta < input.threshold * 10) return { severity: 'HIGH', recommendedAction: 'ROLLBACK' };
  return { severity: 'CRITICAL', recommendedAction: 'ROLLBACK' };
}

function averageDelta(baseline: Record<string, number>, observed: Record<string, number>): number {
  const keys = Object.keys(baseline);
  let total = 0;
  let count = 0;
  for (const key of keys) {
    if (baseline[key] === 0) continue;
    total += (observed[key] - baseline[key]) / baseline[key];
    count++;
  }
  return count > 0 ? total / count : 0;
}