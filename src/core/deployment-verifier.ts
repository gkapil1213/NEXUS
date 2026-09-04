export interface DeploymentVerifier {
  verify(deploymentId: string): Promise<boolean>;
}

export class FunctionDeploymentVerifier implements DeploymentVerifier {
  constructor(private fn: (deploymentId: string) => Promise<boolean>) {}
  async verify(deploymentId: string): Promise<boolean> {
    return this.fn(deploymentId);
  }
}
