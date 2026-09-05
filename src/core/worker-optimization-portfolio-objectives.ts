export interface PortfolioObjective {
  objectiveId: string;
  direction: 'MAXIMIZE' | 'MINIMIZE';
  weight: number;
  hardConstraint: boolean;
}

export function validatePortfolioObjectives(objectives: PortfolioObjective[]): { valid: boolean; reason: string } {
  if (objectives.length === 0) return { valid: false, reason: 'no objectives' };
  const total = objectives.reduce((s,o) => s + o.weight, 0);
  if (Math.abs(total - 1.0) > 0.001) return { valid: false, reason: 'weights do not sum to 1' };
  for (const o of objectives) if (o.weight <= 0) return { valid: false, reason: `invalid weight for ${o.objectiveId}` };
  return { valid: true, reason: 'OK' };
}
