import { randomUUID } from 'crypto';

export interface ExecutionStep {
  stepId: string;
  strategyId: string;
  sequence: number;
  action: string;
  parameters: Record<string, unknown>;
  expectedEffect: Record<string, number>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  timeoutMs: number;
  retryPolicy: { maxRetries: number; backoffMs: number };
  verificationRequirement: string;
  rollbackRequirement: string;
}

export interface ExecutionPlan {
  planId: string;
  strategyId: string;
  tenantId: string;
  steps: ExecutionStep[];
  createdAt: string;
  correlationId: string;
}

export function createExecutionPlan(
  strategyId: string,
  tenantId: string,
  correlationId: string,
  steps: Omit<ExecutionStep, 'stepId' | 'strategyId'>[]
): ExecutionPlan {
  const fullSteps: ExecutionStep[] = steps.map((s, idx) => ({
    ...s,
    stepId: randomUUID(),
    strategyId,
    sequence: idx + 1,
  }));
  return {
    planId: randomUUID(),
    strategyId,
    tenantId,
    steps: fullSteps,
    createdAt: new Date().toISOString(),
    correlationId,
  };
}