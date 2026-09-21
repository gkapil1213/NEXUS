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
import type { NexusEngine } from "./db";
import type { Execution } from "./types";

export interface ReleaseDeploymentBridgeDeps {
  deployments: CanonicalDeploymentOrchestrator;
  artifacts: ArtifactService;
  svc: RuntimeBridgeServices;
  /** Phase 103 — when present, enables durable intent + lease. */
  intents?: ReleaseDeploymentIntentService;
  /** Phase 107: engine access for artifact content lookup. Optional; when
   *  absent, imageDigest overrides are disabled and behavior is unchanged. */
  engine?: NexusEngine;
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

    // Phase 170: authoritative project resolution. When the engine is
    // available (production), execution.project_id is canonical and any
    // caller-supplied req.projectId is an assertion. When the engine is
    // intentionally absent (legacy regression fixtures), preserve
    // historical behavior: req.projectId is trusted as before.
    let authoritativeProjectId: string | null = null;
    if (this.deps.engine) {
      const execution = await this.deps.engine.get<Execution>("executions", req.executionId);
      if (!execution) {
        return blocked("execution " + req.executionId + " not found");
      }
      const p = (execution as unknown as { project_id?: unknown }).project_id;
      if (typeof p !== "string" || p.length === 0) {
        return blocked("execution " + req.executionId + " has no authoritative project_id");
      }
      if (req.projectId && req.projectId !== p) {
        return blocked("project mismatch: request=" + req.projectId + " authoritative=" + p);
      }
      authoritativeProjectId = p;
    }

    let artifacts;
    try {
      artifacts = await this.deps.artifacts.list(null, req.executionId);
    } catch (e) {
      return blocked("artifact lookup failed: " + (e as Error).message);
    }
    const bound = artifacts.find((a) => a.id === req.artifactId);
    if (!bound) {
      return blocked(
        "artifact " + req.artifactId + " not registered under execution " + req.executionId,
      );
    }
    // Phase 107: prefer the authoritative registry digest recorded by
    // REGISTRY_PUBLISH when an IMAGE_DIGEST artifact exists for this execution.
    // Additive: no-op when engine is absent or no valid IMAGE_DIGEST artifact
    // is found. On successful override, the legacy content-digest mismatch
    // check is skipped (it compares the artifact's content sha256, not the
    // registry image digest, so applying it after override would be wrong).
    let digestOverridden = false;
    if (this.deps.engine) {
      const imageDigestArtifact = artifacts.find((a) => a.kind === "IMAGE_DIGEST");
      if (imageDigestArtifact) {
        try {
          const rec = await this.deps.engine.get<{ __content?: string }>("artifacts", imageDigestArtifact.id);
          if (rec?.__content) {
            const parsed = JSON.parse(rec.__content) as { digest?: unknown };
            if (typeof parsed.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(parsed.digest)) {
              if (parsed.digest !== req.imageDigest) {
                await this.deps.svc.events.emit({
                  type: "release.image_digest.resolved" as never,
                  source: "ReleaseDeploymentBridge",
                  execution_id: req.executionId,
                  attempt_id: req.attemptId ?? null,
                  payload: {
                    artifact_id: imageDigestArtifact.id,
                    digest: parsed.digest,
                    previous: req.imageDigest,
                  },
                });
              }
              req.imageDigest = parsed.digest;
              digestOverridden = true;
            }
          }
        } catch {
          // Malformed content or engine failure — fall through to legacy check.
        }
      }
    }

    if (!digestOverridden && bound.digest && req.imageDigest && bound.digest !== req.imageDigest) {
      return blocked(
        "artifact digest mismatch: registered=" + bound.digest + " request=" + req.imageDigest,
      );
    }

    const missing: string[] = [];
    if (this.deps.engine) {
      if (!authoritativeProjectId) missing.push("projectId");
    } else {
      if (!req.projectId) missing.push("projectId");
    }
    if (!req.imageRepository) missing.push("imageRepository");
    if (!req.imageTag) missing.push("imageTag");
    if (!req.containerName) missing.push("containerName");
    if (!req.containerPort) missing.push("containerPort");
    if (!req.imageDigest) missing.push("imageDigest");
    if (!req.attemptId) missing.push("attemptId");
    if (missing.length > 0) {
      return blocked("release-execution request missing deployment context: " + missing.join(", "));
    }
    if (req.imageTag === "latest") {
      return blocked("refusing to deploy :latest — immutable tag or digest required");
    }

    /* ---------- Phase 103 durable path (when intents service present) ---------- */

    // Phase 170: when authoritative resolution succeeded, adopt the
    // execution project as the request project for downstream intent
    // and deployment paths. Caller-supplied value cannot override.
    if (authoritativeProjectId) {
      req.projectId = authoritativeProjectId;
    }

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
      attemptId: req.attemptId,
      artifactId: req.artifactId,
      artifactDigest: req.imageDigest,
      commitSha: req.commitSha,
      environment: req.environment,
      projectId: req.projectId,
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
      // Phase 130: prevent concurrent deployments to the same environment.
      if (intents.hasActiveIntentForEnvironment(req.environment, intent.intentKey)) {
        return {
          status: "BLOCKED",
          message:
            "concurrent deployment already active in environment " + req.environment
            + " - retry after it reaches a terminal state",
          deploymentId: null,
        };
      }
      intents.transition(intent.intentKey, "DEPLOYING", {
        provider: "canonical-deployment-orchestrator",
        startedAt: Date.now(),
      });

      await this.emitDeploymentEvent("deployment.execution.started", req, intent);

      await this.deps.svc.events.emit({
        type: "release.deployment_started" as never,
        source: "ReleaseDeploymentBridge",
        execution_id: req.executionId,
        attempt_id: req.attemptId,
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
          attempt_id: req.attemptId,
        });
      } catch (e) {
        // Phase 173: the intent is already DEPLOYING and the orchestrator
        // may have begun the external side effect before throwing. An
        // exception here is not authoritative non-execution. Transition
        // to RECOVERY_REQUIRED so the recovery path reconciles via the
        // provider interface instead of assuming failure or success.
        const reason = (e as Error).message;
        intents.transition(intent.intentKey, "RECOVERY_REQUIRED", {
          recoveryReason: "deployment orchestrator threw: " + reason,
        });
        await this.emitDeploymentEvent("deployment.failed", req, intent, {
          provider_status: "UNKNOWN",
          reason: "orchestrator_exception",
        });
        return {
          status: "RECOVERY_REQUIRED",
          message: "deployment orchestrator outcome unknown: " + reason,
          deploymentId: null,
        };
      }

      const dep = outcome.deployment;
      if (dep.status === "KNOWN_GOOD") {
        intents.transition(intent.intentKey, "KNOWN_GOOD", {
          deploymentId: dep.id,
          provider: "canonical-deployment-orchestrator",
          providerStatus: dep.status,
          providerDeploymentId: dep.id,
          completedAt: Date.now(),
        });
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
            attempt_id: req.attemptId,
            image_digest: req.imageDigest,
            environment: req.environment,
            intent_key: intent.intentKey,
          },
        });
        await this.emitDeploymentEvent("deployment.provider.result", req, intent, { provider_status: dep.status, deployment_id: dep.id });
        await this.emitDeploymentEvent("deployment.succeeded", req, intent, { deployment_id: dep.id });
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
          provider: "canonical-deployment-orchestrator",
          providerStatus: dep.status,
          providerDeploymentId: dep.id,
          completedAt: Date.now(),
        });
        await this.emitDeploymentEvent("deployment.provider.result", req, intent, { provider_status: dep.status, deployment_id: dep.id });
        await this.emitDeploymentEvent("deployment.failed", req, intent, { provider_status: dep.status, deployment_id: dep.id, reason: dep.failure_reason ?? "deployment blocked" });
        return {
          status: "BLOCKED",
          message: dep.failure_reason ?? "deployment blocked",
          deploymentId: dep.id,
        };
      }
      intents.transition(intent.intentKey, "FAILED", {
        deploymentId: dep.id,
        failureReason: dep.failure_reason ?? ("deployment status=" + dep.status),
        provider: "canonical-deployment-orchestrator",
        providerStatus: dep.status,
        providerDeploymentId: dep.id,
        completedAt: Date.now(),
      });
      await this.emitDeploymentEvent("deployment.provider.result", req, intent, { provider_status: dep.status, deployment_id: dep.id });
      await this.emitDeploymentEvent("deployment.failed", req, intent, { provider_status: dep.status, deployment_id: dep.id, reason: dep.failure_reason ?? ("deployment status=" + dep.status) });
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
  /** Phase 138 section 15: emit a deployment lifecycle event with standard fields. */
  private async emitDeploymentEvent(
    type: string,
    req: ReleaseExecutionRequest,
    intent: { intentKey: string },
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.deps.svc.events.emit({
      type: type as never,
      source: "ReleaseDeploymentBridge",
      execution_id: req.executionId,
      attempt_id: req.attemptId,
      payload: {
        release_id: req.releaseId,
        artifact_id: req.artifactId,
        intent_key: intent.intentKey,
        environment: req.environment,
        image_digest: req.imageDigest,
        ...extra,
      },
    });
  }
  private async executeDirect(req: ReleaseExecutionRequest): Promise<ReleaseExecutionOutcome> {
    await this.deps.svc.events.emit({
      type: "release.ready" as never,
      source: "ReleaseDeploymentBridge",
      execution_id: req.executionId,
      attempt_id: req.attemptId ?? null,
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
        attempt_id: req.attemptId,
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
          attempt_id: req.attemptId ?? null,
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
