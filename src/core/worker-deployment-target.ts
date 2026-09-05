import { randomUUID } from 'crypto';

export type DeploymentTargetStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED' | 'UNKNOWN';
export type TargetType = 'KUBERNETES' | 'DOCKER' | 'VM' | 'HTTP' | 'CLOUD' | 'CUSTOM';

export interface DeploymentTarget {
  targetId: string;
  name: string;
  environment: string;
  provider: string;
  region?: string;
  endpoint?: string;
  capabilities: string[];
  status: DeploymentTargetStatus;
  authenticationRef?: string;
  configurationFingerprint: string;
  healthState: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  idempotencyKey: string;
}

export function createDeploymentTarget(
  input: Omit<DeploymentTarget, 'createdAt' | 'updatedAt' | 'idempotencyKey'> & { targetId?: string; idempotencyKey?: string }
): DeploymentTarget {
  const { targetId, ...rest } = input;
  const idempotencyKey = input.idempotencyKey ?? `${input.environment}:${input.provider}:${input.configurationFingerprint}`;
  const now = new Date().toISOString();
  return {
    targetId: targetId ?? randomUUID(),
    ...rest,
    createdAt: now,
    updatedAt: now,
    idempotencyKey,
  };
}

export function isTargetAvailable(target: DeploymentTarget): boolean {
  return target.status === 'AVAILABLE' && target.healthState === 'HEALTHY';
}
