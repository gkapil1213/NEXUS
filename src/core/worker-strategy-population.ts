import { randomUUID } from 'crypto';

export interface StrategyPopulation {
  populationId: string;
  tenantId: string;
  strategyIds: string[];
  generationIds: string[];
  lineageIds: string[];
  populationVersion: number;
  status: 'ACTIVE' | 'PAUSED' | 'DEGRADED' | 'RECOVERING' | 'FROZEN';
  activeStrategyId?: string;
  challengerStrategyIds: string[];
  retiredStrategyIds: string[];
  populationHealth: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'STAGNANT' | 'FRAGILE' | 'RECOVERY_REQUIRED';
  diversityScore: number;
  convergenceScore: number;
  stagnationScore: number;
  explorationPressure: number;
  exploitationPressure: number;
  populationConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createStrategyPopulation(
  input: Omit<StrategyPopulation, 'populationId' | 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): StrategyPopulation {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.correlationId}`;
  const now = new Date().toISOString();
  return { populationId: randomUUID(), ...input, createdAt: now, updatedAt: now, idempotencyKey };
}

export function updatePopulationVersion(population: StrategyPopulation, newVersion: number): StrategyPopulation {
  return { ...population, populationVersion: newVersion, updatedAt: new Date().toISOString() };
}
