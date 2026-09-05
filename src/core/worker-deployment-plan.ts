import { randomUUID } from 'crypto';

export type RolloutStrategy = 'ALL_AT_ONCE' | 'ROLLING' | 'CANARY' | 'BLUE_GREEN';

export interface DeploymentPlan {
  planId: string;
  releaseId: string;
  artifactId: string;
  targetId: string;
  environment: string;
  strategy: RolloutStrategy;
  rolloutConfig: Record<string, unknown>;
  healthGates: Record<string, number>;
  rollbackPolicy: string;
  timeoutMs: number;
  approvalRequired: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fingerprint: string;
  createdBy: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
}

export function createDeploymentPlan(
  input: Omit<DeploymentPlan, 'planId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentPlan {
  const fingerprint = `${input.releaseId}:${input.artifactId}:${input.targetId}:${input.strategy}:${input.environment}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return { planId: randomUUID(), ...input, fingerprint, createdAt: new Date().toISOString(), idempotencyKey };
}
