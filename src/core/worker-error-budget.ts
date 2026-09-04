export class WorkerErrorBudget {
  calculate(target: number, windowMs: number, observedFailures: number, totalRequests: number): { budget: number; consumed: number; remaining: number; burnRate: number; sufficient: boolean } {
    if (!Number.isFinite(target) || !Number.isFinite(windowMs) || target <= 0 || windowMs <= 0 || !Number.isFinite(observedFailures) || !Number.isFinite(totalRequests) || totalRequests < 0) {
      return { budget: 0, consumed: 0, remaining: 0, burnRate: 0, sufficient: false };
    }
    const budget = target * totalRequests;
    const consumed = observedFailures;
    const remaining = Math.max(budget - consumed, 0);
    const burnRate = budget > 0 ? consumed / budget : 0;
    return { budget, consumed, remaining, burnRate, sufficient: totalRequests >= 3 };
  }
}
