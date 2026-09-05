export interface ErrorBudget {
  total: number;
  consumed: number;
  remaining: number;
  burnRate: number;
  exhaustionRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function evaluateErrorBudget(total: number, consumed: number, burnRate: number): ErrorBudget {
  const remaining = Math.max(0, total - consumed);
  const exhaustionRisk = burnRate > 0.8 ? 'CRITICAL' : burnRate > 0.6 ? 'HIGH' : burnRate > 0.3 ? 'MEDIUM' : 'LOW';
  return { total, consumed, remaining, burnRate, exhaustionRisk };
}
