import { ExecutionStore } from "./execution-store";
import { DeploymentRecord } from "./execution-models";

export class RollbackManager {
  constructor(
    private store: ExecutionStore,
    private executionFn: (deploymentId: string) => Promise<boolean>,
    private verificationFn: (deploymentId: string) => Promise<boolean>
  ) {}

  async rollback(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    const rollbackDeployment: DeploymentRecord = {
      deploymentId: `rollback_${deployment.deploymentId}_${Date.now()}`,
      releaseId: deployment.releaseId,
      environment: deployment.environment,
      status: "ROLLING_BACK",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.addDeployment(rollbackDeployment);
    deployment.rollbackDeploymentId = rollbackDeployment.deploymentId;
    deployment.status = "ROLLING_BACK";
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(deployment);

    let execSuccess = false;
    try {
      execSuccess = await this.executionFn(rollbackDeployment.deploymentId);
    } catch {
      execSuccess = false;
    }

    if (!execSuccess) {
      rollbackDeployment.status = "FAILED";
      rollbackDeployment.updatedAt = Date.now();
      this.store.updateDeployment(rollbackDeployment);
      deployment.status = "INTERVENTION_REQUIRED";
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }

    // verify rollback
    let verified = false;
    try {
      verified = await this.verificationFn(rollbackDeployment.deploymentId);
    } catch {
      verified = false;
    }

    if (verified) {
      rollbackDeployment.status = "SUCCEEDED";
      deployment.status = "ROLLED_BACK";
    } else {
      rollbackDeployment.status = "FAILED";
      deployment.status = "INTERVENTION_REQUIRED";
    }
    rollbackDeployment.updatedAt = Date.now();
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(rollbackDeployment);
    this.store.updateDeployment(deployment);
    return deployment;
  }
}
