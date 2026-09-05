export interface StrategyConstraint {
  constraintId: string;
  type: 'HARD' | 'SOFT';
  metric: string;
  limit: number;
  currentValue: number;
  compare: 'LT' | 'GT' | 'LTE' | 'GTE';
  source: string;
}

export function checkConstraint(constraint: StrategyConstraint): boolean {
  switch (constraint.compare) {
    case 'LT': return constraint.currentValue < constraint.limit;
    case 'GT': return constraint.currentValue > constraint.limit;
    case 'LTE': return constraint.currentValue <= constraint.limit;
    case 'GTE': return constraint.currentValue >= constraint.limit;
    default: return false;
  }
}
