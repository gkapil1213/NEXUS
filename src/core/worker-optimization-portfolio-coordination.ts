export interface CoordinationInput {
  activeExperiments: number;
  conflictingExperiments: boolean;
  duplicateExperiments: boolean;
  budgetExhausted: boolean;
  fatigue: boolean;
  safetyHealthy: boolean;
}

export function coordinateExperiments(input: CoordinationInput): { proceed: boolean; reason: string } {
  if (!input.safetyHealthy) return { proceed: false, reason: 'safety unhealthy' };
  if (input.conflictingExperiments) return { proceed: false, reason: 'conflicting experiments' };
  if (input.duplicateExperiments) return { proceed: false, reason: 'duplicate experiments' };
  if (input.budgetExhausted) return { proceed: false, reason: 'budget exhausted' };
  if (input.fatigue) return { proceed: false, reason: 'fatigue' };
  return { proceed: true, reason: 'OK' };
}
