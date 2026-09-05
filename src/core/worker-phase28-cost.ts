export interface CostObservation {
  observationId: string;
  resourceId: string;
  service: string;
  environment: string;
  periodStart: string;
  periodEnd: string;
  cost: number | null;
  currency: string;
  budget: number;
  forecastCost: number | null;
  createdAt: string;
}

export function createCostObservation(input: Omit<CostObservation, 'observationId' | 'createdAt'>): CostObservation {
  return { observationId: `cost-${Date.now()}`, ...input, createdAt: new Date().toISOString() };
}

export function hasCostData(observation: CostObservation): boolean {
  return observation.cost !== null && observation.forecastCost !== null;
}
