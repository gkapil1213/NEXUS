export class ErrorBudgetService {
  calculate(totalRequests: number, failedRequests: number, allowedErrorRate: number): any {
    const allowedErrors = Math.floor(totalRequests * (allowedErrorRate / 100));
    const observedErrors = failedRequests;
    const remainingBudget = Math.max(0, allowedErrors - observedErrors);
    const budgetConsumed = allowedErrors > 0 ? (observedErrors / allowedErrors) * 100 : 0;
    return {
      allowed_errors: allowedErrors,
      observed_errors: observedErrors,
      remaining_budget: remainingBudget,
      budget_consumed_percent: budgetConsumed
    };
  }
}
