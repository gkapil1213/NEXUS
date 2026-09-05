import { randomUUID } from 'crypto';

export interface StrategyOutcome {
  outcomeId: string;
  strategyId: string;
  executionId: string;
  experimentId?: string;
  objectiveId: string;
  baselineMetrics: Record<string, number>;
  expectedOutcome: Record<string, number>;
  actualOutcome: Record<string, number>;
  delta: Record<string, number>;
  costImpact: number;
  reliabilityImpact: number;
  latencyImpact: number;
  qualityImpact: number;
  resourceImpact: number;
  riskImpact: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  observationWindowDays: number;
  outcomeTimestamp: string;
  evidenceReferences: string[];
  tenantId: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createStrategyOutcome(
  input: Omit<StrategyOutcome, 'outcomeId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): StrategyOutcome {
  const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.strategyId}:${input.executionId}:${input.correlationId}`;
  return {
    outcomeId: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
