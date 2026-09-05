export interface DeploymentIncident {
  incidentId: string;
  deploymentId: string;
  releaseId: string;
  target: string;
  failureReason: string;
  healthEvidence: string;
  rollbackState: string;
  recoveryState: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createDeploymentIncident(
  input: Omit<DeploymentIncident, 'incidentId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentIncident {
  const idempotencyKey = input.idempotencyKey ?? `${input.deploymentId}:${input.failureReason}`;
  return { incidentId: `inc-${input.deploymentId}-${Date.now()}`, ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
