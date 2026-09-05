export interface ExecutionSafetyInput {
  authorized: boolean;
  constraintsValid: boolean;
  budgetWithinLimit: boolean;
  concentrationAcceptable: boolean;
  evidenceSufficient: boolean;
  strategyStateValid: boolean;
  noConflictingExecution: boolean;
  rollbackAvailable: boolean;
  resourceUsageNormal: boolean;
}

export function evaluateExecutionSafety(input: ExecutionSafetyInput): { allowed: boolean; reason: string } {
  if (!input.authorized) return { allowed: false, reason: 'not authorized' };
  if (!input.constraintsValid) return { allowed: false, reason: 'constraints invalid' };
  if (!input.budgetWithinLimit) return { allowed: false, reason: 'budget over limit' };
  if (!input.concentrationAcceptable) return { allowed: false, reason: 'concentration too high' };
  if (!input.evidenceSufficient) return { allowed: false, reason: 'insufficient evidence' };
  if (!input.strategyStateValid) return { allowed: false, reason: 'invalid strategy state' };
  if (!input.noConflictingExecution) return { allowed: false, reason: 'conflicting execution' };
  if (!input.rollbackAvailable) return { allowed: false, reason: 'rollback unavailable' };
  if (!input.resourceUsageNormal) return { allowed: false, reason: 'abnormal resource usage' };
  return { allowed: true, reason: 'OK' };
}
