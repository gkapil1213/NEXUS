export type ObjectiveName = 'RELIABILITY' | 'LATENCY' | 'THROUGHPUT' | 'COST' | 'CAPACITY' | 'SECURITY' | 'AVAILABILITY' | 'ERROR_RATE' | 'RESOURCE_EFFICIENCY' | 'RECOVERY_TIME';

export interface ObjectiveDefinition {
  name: ObjectiveName;
  target: number;
  currentValue: number;
  baseline: number;
  direction: 'MAXIMIZE' | 'MINIMIZE';
  weight: number;
  tolerance: number;
  hardConstraint: boolean;
  priority: number; // lower number = higher priority
}

export function validateObjectives(objectives: ObjectiveDefinition[]): { valid: boolean; reason: string } {
  const totalWeight = objectives.reduce((sum, o) => sum + o.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 0.001) {
    return { valid: false, reason: `Objective weights sum to ${totalWeight}, expected 1.0` };
  }
  for (const o of objectives) {
    if (o.weight < 0) return { valid: false, reason: `Negative weight for ${o.name}` };
    if (o.tolerance < 0) return { valid: false, reason: `Negative tolerance for ${o.name}` };
    if (o.priority < 0) return { valid: false, reason: `Negative priority for ${o.name}` };
    if (o.hardConstraint && o.weight <= 0) {
      return { valid: false, reason: `Hard constraint ${o.name} must have positive weight` };
    }
  }
  return { valid: true, reason: 'OK' };
}
