import { randomUUID } from 'crypto';

export interface ExecutionStep {
  stepId: string;
  strategyId: string;
  action: string;
  parameters: Record<string, unknown>;
  dependsOn: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  timeoutMs: number;
  retryPolicy: 'NONE' | 'TRANSIENT_ONLY' | 'PERMANENT';
}

export interface ExecutionPlan {
  planId: string;
  portfolioId: string;
  version: number;
  steps: ExecutionStep[];
  fingerprint: string;
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createExecutionPlan(
  input: Omit<ExecutionPlan, 'planId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): ExecutionPlan {
  const fingerprint = `${input.portfolioId}:${input.version}:${JSON.stringify(input.steps)}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return {
    planId: randomUUID(),
    ...input,
    fingerprint,
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}
