import { randomUUID } from 'crypto';

export interface DeploymentEvidence {
  evidenceId: string;
  tenantId: string;
  correlationId: string;
  deploymentId: string;
  evidenceType: string;
  data: Record<string, unknown>;
  timestamp: string;
  idempotencyKey: string;
}

export function createDeploymentEvidence(
  input: Omit<DeploymentEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.deploymentId}:${input.evidenceType}`;
  return { evidenceId: randomUUID(), ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
