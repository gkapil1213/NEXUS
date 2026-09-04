import { ExecutionStore } from "./execution-store";
import { DeploymentGates } from "./deployment-gates";
import { DeploymentVerifier } from "./deployment-verifier";
import { RollbackManager } from "./rollback-manager";
import { ApprovalGate } from "./approval-gate";
import {
  DeploymentRecord,
  ReleaseRecord,
  ArtifactRecord,
  ApprovalRequest,
} from "./execution-models";

export interface DeploymentDeps {
  executionFn: (deploymentId: string) => Promise<boolean>;
  verificationFn: (deploymentId: string) => Promise<boolean>;
}

export class DeploymentManager {
  constructor(
    private store: ExecutionStore,
    private gates: DeploymentGates,
    private approvalGate: ApprovalGate,
    private deps: DeploymentDeps
  ) {}

  async deploy(
    release: ReleaseRecord,
    environment: string,
    artifact?: ArtifactRecord,
    evidence: string[] = []
  ): Promise<DeploymentRecord> {
    const deployment: DeploymentRecord = {
      deploymentId: `deploy_${release.releaseId}_${Date.now()}`,
      releaseId: release.releaseId,
      environment,
      status: "PREPARING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      evidence: [],
    };
    this.store.addDeployment(deployment);

    // 1. Safety gates
    deployment.status = "GATE_CHECKING";
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(deployment);

    const gateResults = this.gates.evaluate(release, artifact, evidence);
    const mandatoryGates = [
      "BUILD_PASS",
      "TEST_PASS",
      "SECURITY_PASS",
      "ARTIFACT_PRESENT",
      "ARTIFACT_INTEGRITY_PASS",
    ];
    const gatesPassed = this.gates.allMandatoryPassed(gateResults, mandatoryGates);
    if (!gatesPassed) {
      deployment.status = "FAILED";
      deployment.evidence = gateResults.map((g) => `${g.gate}:${g.passed ? "PASS" : "FAIL"}`);
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }

    // 2. Approval
    const approvalRequired = this.approvalGate.evaluate(
      deployment.deploymentId,
      release.releaseId,
      environment,
      "deploy"
    );
    if (approvalRequired === "HUMAN_APPROVAL_REQUIRED") {
      deployment.status = "APPROVAL_REQUIRED";
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }
    if (approvalRequired === "DENIED" || approvalRequired === "BLOCKED") {
      deployment.status = "FAILED";
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }

    // automatic approval: record it
    const approval: ApprovalRequest = {
      approvalId: `approval_${deployment.deploymentId}`,
      deploymentId: deployment.deploymentId,
      releaseId: release.releaseId,
      environment,
      requestedAction: "deploy",
      decision: approvalRequired,
      decidedAt: Date.now(),
      decidedBy: "system",
      createdAt: Date.now(),
    };
    this.approvalGate.recordApproval(approval);

    // 3. Execute
    deployment.status = "DEPLOYING";
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(deployment);

    let executionSuccess = false;
    try {
      executionSuccess = await this.deps.executionFn(deployment.deploymentId);
    } catch {
      executionSuccess = false;
    }

    if (!executionSuccess) {
      deployment.status = "FAILED";
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }

    // 4. Verify
    deployment.status = "VERIFYING";
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(deployment);

    let verified = false;
    try {
      verified = await this.deps.verificationFn(deployment.deploymentId);
    } catch {
      verified = false;
    }

    if (verified) {
      deployment.status = "SUCCEEDED";
      deployment.updatedAt = Date.now();
      this.store.updateDeployment(deployment);
      return deployment;
    }

    // 5. Rollback on failed verification
    const rollbackManager = new RollbackManager(
      this.store,
      this.deps.executionFn,
      this.deps.verificationFn
    );
    deployment.status = "ROLLING_BACK";
    deployment.updatedAt = Date.now();
    this.store.updateDeployment(deployment);

    return await rollbackManager.rollback(deployment);
  }

  getDeployment(deploymentId: string): DeploymentRecord | undefined {
    return this.store.getDeployment(deploymentId);
  }
}
