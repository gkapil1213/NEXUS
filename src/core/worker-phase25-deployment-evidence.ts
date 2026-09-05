export interface DeploymentEvidence {
  evidenceId: string;
  deploymentId: string;
  releaseId: string;
  artifactId: string;
  provider: string;
  strategy: string;
  healthResult: string;
  rollbackState: string;
  finalResult: string;
  timestamp: string;
  idempotencyKey: string;
}

export function createDeploymentEvidence(
  input: Omit<DeploymentEvidence, 'evidenceId' | 'timestamp' | 'idempotencyKey'> & { idempotencyKey?: string }
): DeploymentEvidence {
  const idempotencyKey = input.idempotencyKey ?? `${input.deploymentId}:${input.artifactId}`;
  return { evidenceId: `evidence-${input.deploymentId}-${Date.now()}`, ...input, timestamp: new Date().toISOString(), idempotencyKey };
}
