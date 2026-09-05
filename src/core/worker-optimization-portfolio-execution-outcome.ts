import { randomUUID } from 'crypto';

export interface ExecutionOutcome {
  outcomeId: string;
  executionId: string;
  portfolioId: string;
  portfolioVersion: number;
  strategyId: string;
  strategyGenerationId: string;
  experimentId?: string;
  metaExperimentId?: string;
  decisionId?: string;
  resourceUsed: number;
  result: 'SUCCESS' | 'PARTIAL' | 'FAILURE' | 'ROLLED_BACK';
  evidence: string[];
  timestamp: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createExecutionOutcome(
  input: Omit<ExecutionOutcome, 'outcomeId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExecutionOutcome {
  const idempotencyKey = input.idempotencyKey ?? `${input.executionId}:${input.strategyId}:${input.correlationId}`;
  return { outcomeId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
