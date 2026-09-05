export interface DeploymentConfiguration {
  configId: string;
  configVersion: number;
  configFingerprint: string;
  environment: string;
  targetId: string;
  releaseId: string;
  source: string;
  changeReason: string;
  approvalState: 'APPROVED' | 'PENDING' | 'REJECTED';
  timestamp: string;
}

export function createDeploymentConfiguration(
  input: Omit<DeploymentConfiguration, 'configId' | 'timestamp'>
): DeploymentConfiguration {
  return { ...input, configId: `config-${input.environment}-${input.targetId}-${input.configVersion}`, timestamp: new Date().toISOString() };
}
