export interface CostObservation {
  observationId: string;
  resourceId: string;
  date: string;
  cost: number | null;
  currency: string;
  provider: string;
}

export function createCostObservation(input: Omit<CostObservation, 'observationId'>): CostObservation {
  return { observationId: `cost-${input.resourceId}-${input.date}`, ...input };
}

export function hasCostData(obs: CostObservation): boolean {
  return obs.cost !== null;
}
