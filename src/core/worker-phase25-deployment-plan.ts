import { randomUUID } from 'crypto';

export type DeploymentStrategy = 'RECREATE' | 'ROLLING' | 'BLUE_GREEN' | 'CANARY';

export interface DeploymentPlan {
  planId: string;
  releaseId: string;
  artifactId: string;
  target: string;
  environment: string;
  strategy: DeploymentStrategy;
  rolloutConfig: Record<string, unknown>;
  healthRequirements: string[];
  rollbackPolicy: string;
  timeoutMs: number;
  approvalRequired: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fingerprint: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createDeploymentPlan(
  input: Omit<DeploymentPlan, 'planId' | 'createdAt' | 'fingerprint' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentPlan {
  const fingerprint = `${input.releaseId}:${input.artifactId}:${input.target}:${input.strategy}`;
  const idempotencyKey = input.idempotencyKey ?? fingerprint;
  return { planId: randomUUID(), ...input, fingerprint, createdAt: new Date().toISOString(), idempotencyKey };
}
