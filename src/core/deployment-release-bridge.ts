// src/core/deployment-release-bridge.ts
// Phase 102/103: canonical bridge from production release enforcement to the
// canonical deployment orchestrator. Fail closed at every step.
//
// Phase 103 adds durable intent + lease semantics. When an intents service is
// provided, every execute() is idempotent by deterministic intent key, and
// non-terminal intents never re-invoke Docker — they return BLOCKED with a
// RECOVERY_REQUIRED message so the caller must run recovery first.

import type { CanonicalDeploymentOrchestrator } from "./deployment-orchestrator";
import type { RuntimeBridgeServices } from "./runtime";
import type { ArtifactService } from "./services";
import type {
  ReleaseExecutionProvider,
  ReleaseExecutionRequest,
  ReleaseExecutionOutcome,
} from "./production-release-enforcement";
import type { ReleaseDeploymentIntentService, ReleaseIntentInput } from "./release-deployment-intent";

export interface ReleaseDeploymentBridgeDeps {
  deployments: CanonicalDeploymentOrchestrator;
  artifacts: ArtifactService;
  svc: RuntimeBridgeServices;
  /** Phase 103 — when present, enables durable intent + lease. */
  intents?: ReleaseDeploymentIntentService;
  /** Phase 103 — lease holder identity. Defaults to a per-call id. */
  workerId?: string;
}

export class ReleaseDeploymentBridge implements ReleaseExecutionProvider {
  constructor(private readonly deps: ReleaseDeploymentBridgeDeps) {}

  async execute(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    const blocked = (msg: string): ReleaseExecutionOutcome => ({
      status: "BLOCKED",
      message: msg,
      deploymentId: null,
    });

    /* ---------- Phase 102 validations (unchanged) ---------- */

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
      return blocked("refusing to deploy :latest — immutable tag or digest required");
    }

    /* ---------- Phase 103 durable path (when intents service present) ---------- */

    if (this.deps.intents) {
      return this.executeWithIntent(req);
    }

    /* ---------- Phase 102 legacy path ---------- */

    return this.executeDirect(req);
  }

  /**
   * Phase 103 durable execution: idempotent by intent key. Non-terminal
   * intents return BLOCKED with a RECOVERY_REQUIRED marker; caller must
   * use ReleaseRecoveryService and re-run only after validation.
   */
  private async executeWithIntent(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    const intents = this.deps.intents!;
    const workerId = this.deps.workerId ?? ("bridge-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));

    const input: ReleaseIntentInput = {
      releaseId: req.releaseId,
      executionId: req.executionId!,
      artifactId: req.artifactId,
      artifactDigest: req.imageDigest,
      commitSha: req.commitSha,
      environment: req.environment,
      imageRepository: req.imageRepository!,
      imageTag: req.imageTag!,
      imageId: req.imageId,
      imageDigest: req.imageDigest,
      containerName: req.containerName!,
      containerPort: req.containerPort!,
    };

    const { intent, created } = await intents.getOrCreate(input);

    /* T44, T45, T49, T51: existing intent — never re-invoke Docker blindly. */

    if (!created) {
      if (intent.status === "KNOWN_GOOD") {
        return {
          status: "DEPLOYED",
          message: "idempotent: existing KNOWN_GOOD deployment " + (intent.deploymentId ?? ""),
          deploymentId: intent.deploymentId ?? undefined,
        };
      }
      if (intent.status === "FAILED") {
        return {
          status: "FAIL",
          message: "idempotent: prior intent FAILED: " + (intent.failureReason ?? ""),
          deploymentId: intent.deploymentId ?? undefined,
        };
      }
      if (intent.status === "BLOCKED") {
        return {
          status: "BLOCKED",
          message: "idempotent: prior intent BLOCKED: " + (intent.failureReason ?? ""),
          deploymentId: intent.deploymentId ?? undefined,
        };
      }
      // Non-terminal (DEPLOYMENT_INTENT_CREATED, DEPLOYING, HEALTH_CHECKING,
      // SMOKE_TESTING, ROLLING_BACK, RECOVERY_REQUIRED, VERIFICATION_FAILED,
      // AUTHORIZED, PENDING) — never re-deploy without recovery.
      return {
        status: "BLOCKED",
        message:
          "intent in non-terminal state " + intent.status
          + " — RECOVERY_REQUIRED (run ReleaseRecoveryService before retrying)",
        deploymentId: intent.deploymentId ?? undefined,
      };
    }

    /* T52, T53: acquire the durable intent lease.
       Lease contention is transient. Never convert a live intent into
       terminal BLOCKED merely because another worker currently owns it. */

    const lease = intents.acquireLease(intent.intentKey, workerId);
    if (!lease.acquired) {
      return {
        status: "BLOCKED",
        message:
          "release intent is currently leased by " + (lease.holder ?? "unknown")
          + " until " + (lease.expiresAt ?? "unknown")
          + " — retry or run recovery after lease expiry",
        deploymentId: null,
      };
    }
    try {
      intents.transition(intent.intentKey, "DEPLOYING");

      await this.deps.svc.events.emit({
        type: "release.deployment_started" as never,
        source: "ReleaseDeploymentBridge",
        execution_id: req.executionId,
        payload: {
          release_id: req.releaseId,
          artifact_id: req.artifactId,
          intent_key: intent.intentKey,
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
        intents.transition(intent.intentKey, "FAILED", {
          failureReason: "deployment orchestrator rejected request: " + (e as Error).message,
        });
        return {
          status: "FAIL",
          message: "deployment orchestrator rejected request: " + (e as Error).message,
          deploymentId: null,
        };
      }

      const dep = outcome.deployment;
      if (dep.status === "KNOWN_GOOD") {
        intents.transition(intent.intentKey, "KNOWN_GOOD", { deploymentId: dep.id });
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
            intent_key: intent.intentKey,
          },
        });
        return {
          status: "DEPLOYED",
          message: "deployed " + dep.id + " (status=KNOWN_GOOD)",
          deploymentId: dep.id,
        };
      }
      if (dep.status === "BLOCKED") {
        intents.transition(intent.intentKey, "BLOCKED", {
          deploymentId: dep.id,
          failureReason: dep.failure_reason ?? "deployment blocked",
        });
        return {
          status: "BLOCKED",
          message: dep.failure_reason ?? "deployment blocked",
          deploymentId: dep.id,
        };
      }
      intents.transition(intent.intentKey, "FAILED", {
        deploymentId: dep.id,
        failureReason: dep.failure_reason ?? ("deployment status=" + dep.status),
      });
      return {
        status: "FAIL",
        message: dep.failure_reason ?? ("deployment status=" + dep.status),
        deploymentId: dep.id,
      };
    } finally {
      intents.releaseLease(intent.intentKey, workerId);
    }
  }

  /** Phase 102 legacy path — no durable intent, direct deploy. */
  private async executeDirect(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
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