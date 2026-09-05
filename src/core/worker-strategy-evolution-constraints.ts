export interface StrategyEvolutionConstraint {
  constraintId: string;
  type: 'HARD' | 'SOFT';
  metric: string;
  limit: number;
  currentValue: number;
  compare: 'LT' | 'GT' | 'LTE' | 'GTE';
  source: string;
}

export function validateStrategyEvolutionConstraints(constraints: StrategyEvolutionConstraint[]): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const c of constraints) {
    let pass = false;
    switch (c.compare) {
      case 'LT': pass = c.currentValue < c.limit; break;
      case 'GT': pass = c.currentValue > c.limit; break;
      case 'LTE': pass = c.currentValue <= c.limit; break;
      case 'GTE': pass = c.currentValue >= c.limit; break;
    }
    if (!pass) violations.push(`Constraint ${c.constraintId} violated: ${c.metric} ${c.compare} ${c.limit} (current=${c.currentValue})`);
  }
  return { valid: violations.length === 0, violations };
}
