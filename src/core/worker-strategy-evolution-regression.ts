export type RegressionDecision = 'ACCEPT' | 'REJECT' | 'HOLD';

export interface RegressionInput {
  baseline: Record<string, number>;
  candidate: Record<string, number>;
  allowedRegression: Record<string, number>; // e.g., { reliability: 0.005, latency: 10, cost: 20 }
  criticalMetrics: string[]; // metrics that cannot regress beyond allowed
}

export function evaluateRegression(input: RegressionInput): { decision: RegressionDecision; violations: string[] } {
  const violations: string[] = [];
  for (const key of Object.keys(input.baseline)) {
    const base = input.baseline[key];
    const cand = input.candidate[key] ?? base;
    const allowed = input.allowedRegression[key] ?? 0;
    // For "higher is better" metrics, a decrease is regression. For "lower is better", increase is regression.
    // We assume lower is better for simplicity in this module; adjust if needed.
    const regression = cand - base;
    if (regression > allowed) {
      violations.push(`${key} regressed by ${regression} (allowed ${allowed})`);
    }
  }
  if (violations.length === 0) return { decision: 'ACCEPT', violations: [] };
  const criticalViolation = violations.some(v => input.criticalMetrics.some(m => v.startsWith(m)));
  return { decision: criticalViolation ? 'REJECT' : 'HOLD', violations };
}
