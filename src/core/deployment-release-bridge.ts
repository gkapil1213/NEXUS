// src/core/deployment-release-bridge.ts
// Phase 102: canonical bridge from production release enforcement to the
// canonical deployment orchestrator. Fail closed at every step.

import type { CanonicalDeploymentOrchestrator } from "./deployment-orchestrator";
import type { RuntimeBridgeServices } from "./runtime";
import type { ArtifactService } from "./services";
import type {
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
} from "./production-release-enforcement";

export interface ReleaseDeploymentBridgeDeps {
  deployments: CanonicalDeploymentOrchestrator;
  artifacts: ArtifactService;
  svc: RuntimeBridgeServices;
}

export class ReleaseDeploymentBridge implements ReleaseExecutionProvider {
  constructor(private readonly deps: ReleaseDeploymentBridgeDeps) {}

  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    const blocked = (msg: string): ReleaseExecutionOutcome => ({
      status: "BLOCKED",
      message: msg,
      deploymentId: null,
    });

    if (!req.executionId) {
      return blocked("execution_id required to verify artifact binding");
    }

    let artifacts;
    try {
      artifacts = await this.deps.artifacts.list(req.executionId);
    } catch (e) {
      return blocked("artifact lookup failed: " + (e as Error).message);
    }
    const bound = artifacts.find((a) => a.id === req.artifactId);
    if (!bound) {
      return blocked(
        "artifact " + req.artifactId + " not registered under execution " + req.executionId,
      );
    }
    if (bound.digest && req.imageDigest && bound.digest !== req.imageDigest) {
      return blocked(
        "artifact digest mismatch: registered=" + bound.digest + " request=" + req.imageDigest,
      );
    }

    const missing: string[] = [];
    if (!req.projectId) missing.push("projectId");
    if (!req.imageRepository) missing.push("imageRepository");
    if (!req.imageTag) missing.push("imageTag");
    if (!req.containerName) missing.push("containerName");
    if (!req.containerPort) missing.push("containerPort");
    if (!req.imageDigest) missing.push("imageDigest");
    if (missing.length > 0) {
      return blocked("release-execution request missing deployment context: " + missing.join(", "));
    }
    if (req.imageTag === "latest") {
      return blocked("refusing to deploy :latest - immutable tag or digest required");
    }

    await this.deps.svc.events.emit({
      type: "release.ready" as never,
      source: "ReleaseDeploymentBridge",
      execution_id: req.executionId,
      payload: {
        release_id: req.releaseId,
        artifact_id: req.artifactId,
        authorization_id: req.authorizationId,
        environment: req.environment,
        image_digest: req.imageDigest,
      },
    });

    let outcome;
    try {
      outcome = await this.deps.deployments.deploy({
        project_id: req.projectId!,
        environment: req.environment,
        release_id: req.releaseId,
        artifact_id: req.artifactId,
        commit_sha: req.commitSha,
        image_repository: req.imageRepository!,
        image_tag: req.imageTag!,
        image_id: req.imageId,
        image_digest: req.imageDigest,
        container_name: req.containerName!,
        container_port: req.containerPort!,
        execution_id: req.executionId,
      });
    } catch (e) {
      return {
        status: "FAIL",
        message: "deployment orchestrator rejected request: " + (e as Error).message,
        deploymentId: null,
      };
    }

    const dep = outcome.deployment;
    if (dep.status === "KNOWN_GOOD") {
      await this.deps.svc.audit.record({
        actor: "system",
        action: "release.deployed",
        resource_type: "deployment",
        resource_id: dep.id,
        result: "allow",
        metadata: {
          release_id: req.releaseId,
          artifact_id: req.artifactId,
          execution_id: req.executionId,
          image_digest: req.imageDigest,
          environment: req.environment,
        },
      });
      return {
        status: "DEPLOYED",
        message: "deployed " + dep.id + " (status=KNOWN_GOOD)",
        deploymentId: dep.id,
      };
    }
    if (dep.status === "BLOCKED") {
      return {
        status: "BLOCKED",
        message: dep.failure_reason ?? "deployment blocked",
        deploymentId: dep.id,
      };
    }
    return {
      status: "FAIL",
      message: dep.failure_reason ?? ("deployment status=" + dep.status),
      deploymentId: dep.id,
    };
  }
}