// src/core/deployment-activation-service.ts
// Phase 227: production activation lifecycle.
//
// Extends the durable ReleaseDeploymentIntentService state machine with
// activation states. Does NOT introduce a parallel architecture: every
// transition uses transitionIfOwnedAsync (fenced CAS) and acquireLeaseAsync
// (distributed lease) from the existing Phase 103/211/226 service.
//
// Real traffic cutover is delegated to the TrafficRouter. If the injected
// router is the NoopTrafficRouter, every cutover/revert attempt returns
// BLOCKED with reason NO_TRAFFIC_ROUTER_CONFIGURED, and the intent
// transitions to ACTIVATION_FAILED with that reason persisted.

import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type { ReleaseIntentStatus, ReleaseDeploymentIntent } from "./execution-store";
import type { DeploymentHistoryService } from "./deployment-history";
import type { TrafficRouter, CutoverRequest } from "./traffic-router";
import { NO_TRAFFIC_ROUTER_REASON } from "./traffic-router";
import type { RouterHealthVerdict } from "./traffic-router";

export interface PreviousTargetBinding {
  deploymentId: string;
  releaseId: string | null;
  commitSha: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageId: string | null;
  imageDigest: string | null;
  containerName: string | null;
  containerId: string | null;
  url: string | null;
  capturedAt: number;
}

export interface ActivationResult {
  status: "ACTIVATED" | "BLOCKED" | "FAILED" | "NOT_EXECUTED";
  reason: string | null;
  intent: ReleaseDeploymentIntent | null;
  previousTarget?: PreviousTargetBinding | null;
  cutover: {
    attempted: boolean;
    ok: boolean;
    reason: string | null;
    activeTarget: string | null;
  };
}

export interface ActiveHealthObservationResult {
  status: "OBSERVED" | "BLOCKED" | "NOT_ACTIVE";
  verdict: RouterHealthVerdict | null;
  reason: string | null;
  intent: ReleaseDeploymentIntent | null;
  providerTargetId: string | null;
  observedAt: number;
  transitionedTo: ReleaseIntentStatus | null;
}

export class DeploymentActivationService {
  constructor(
    private readonly intents: ReleaseDeploymentIntentService | undefined,
    private readonly router: TrafficRouter,
    private readonly history?: DeploymentHistoryService,
  ) {}

  private async capturePreviousTarget(
    projectId: string | null,
    environment: string,
  ): Promise<PreviousTargetBinding | null> {
    if (!this.history || !projectId) return null;
    const current = await this.history.getCurrentDeployment(projectId, environment);
    if (!current) return null;
    return {
      deploymentId: current.id,
      releaseId: current.release_id ?? null,
      commitSha: current.commit_sha ?? null,
      imageRepository: current.image_repository ?? null,
      imageTag: current.image_tag ?? null,
      imageId: current.image_id ?? null,
      imageDigest: current.image_digest ?? null,
      containerName: current.container_name ?? null,
      containerId: current.container_id ?? null,
      url: current.url ?? null,
      capturedAt: Date.now(),
    };
  }
  async activate(intentKey: string, workerId: string): Promise<ActivationResult> {
    if (!this.intents) {
      return { status: "BLOCKED", reason: "NO_INTENT_SERVICE", intent: null,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    const current = await this.intents.getAsync(intentKey);
    if (!current) {
      return { status: "BLOCKED", reason: "INTENT_NOT_FOUND", intent: null,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    if (current.status !== "KNOWN_GOOD") {
      return { status: "BLOCKED", reason: "INTENT_NOT_KNOWN_GOOD:" + current.status, intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const lease = await this.intents.acquireLeaseAsync(intentKey, workerId);
    if (!lease.acquired) {
      return { status: "BLOCKED", reason: "ACTIVATION_LEASE_HELD:" + (lease.holder ?? "unknown"), intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const t1 = await this.intents.transitionIfOwnedAsync(
      intentKey, "ACTIVATION_REQUESTED" as ReleaseIntentStatus, workerId, {}, ["KNOWN_GOOD"],
    );
    if (!t1.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      return { status: "BLOCKED", reason: "TRANSITION_ACTIVATION_REQUESTED_REFUSED", intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const t2 = await this.intents.transitionIfOwnedAsync(
      intentKey, "ACTIVATING" as ReleaseIntentStatus, workerId, {}, ["ACTIVATION_REQUESTED"],
    );
    if (!t2.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      return { status: "BLOCKED", reason: "TRANSITION_ACTIVATING_REFUSED", intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    // Phase 228 section 5: capture the current active target for this
    // environment BEFORE any traffic mutation. Persisted in-memory and
    // attached to the result; callers can durably persist it via the
    // DeploymentHistoryService.previous_deployment_id field.
    const capturedPreviousTarget = await this.capturePreviousTarget(
      current.projectId ?? null,
      current.environment,
    );

    const t3 = await this.intents.transitionIfOwnedAsync(
      intentKey, "TRAFFIC_CUTOVER" as ReleaseIntentStatus, workerId, {}, ["ACTIVATING"],
    );
    if (!t3.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      return { status: "BLOCKED", reason: "TRANSITION_TRAFFIC_CUTOVER_REFUSED", intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    // Phase 230: typed AWS routing identity. The activation lifecycle
    // reads the same env vars the AWSTrafficRouter uses for candidate
    // config so the request carries the intended routing target. The
    // router itself re-resolves the current routing via discoverRouting()
    // before mutating, so this is an intent, not a trusted value.
    const candidateTargetGroupArn = process.env.NEXUS_AWS_TARGET_GROUP_ARN || null;
    const awsRouting = candidateTargetGroupArn
      ? {
          loadBalancerArn: process.env.NEXUS_AWS_LOAD_BALANCER_ARN || null,
          listenerArn: process.env.NEXUS_AWS_LISTENER_ARN || null,
          ruleArn: process.env.NEXUS_AWS_RULE_ARN || null,
          candidateTargetGroupArn,
          previousTargetGroupArn: capturedPreviousTarget?.containerName ?? null,
          targetId: null,
          targetPort: process.env.NEXUS_AWS_TARGET_PORT
            ? Number(process.env.NEXUS_AWS_TARGET_PORT)
            : null,
        }
      : undefined;

    const req: CutoverRequest = {
      environment: current.environment,
      intentKey,
      releaseId: current.releaseId,
      commitSha: current.commitSha,
      imageRepository: current.imageRepository,
      imageTag: current.imageTag,
      imageId: current.imageId ?? null,
      imageDigest: current.imageDigest ?? null,
      containerName: current.containerName,
      containerPort: current.containerPort,
      previousContainerName: capturedPreviousTarget?.containerName ?? null,
      aws: awsRouting,
    };

    let cutoverOk = false;
    let cutoverReason: string | null = null;
    let cutoverTarget: string | null = null;
    try {
      const r = await this.router.cutover(req);
      cutoverOk = r.ok;
      cutoverReason = r.reason;
      cutoverTarget = r.activeTarget;
    } catch (e) {
      cutoverOk = false;
      cutoverReason = "router_threw:" + (e instanceof Error ? e.message : String(e));
    }

    if (!cutoverOk) {
      await this.intents.transitionIfOwnedAsync(
        intentKey, "ACTIVATION_FAILED" as ReleaseIntentStatus, workerId,
        { failureReason: cutoverReason ?? NO_TRAFFIC_ROUTER_REASON }, ["TRAFFIC_CUTOVER"],
      );
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
      return {
        status: "BLOCKED",
        reason: cutoverReason ?? NO_TRAFFIC_ROUTER_REASON,
        intent: finalIntent,
        previousTarget: capturedPreviousTarget,
        cutover: { attempted: true, ok: false, reason: cutoverReason, activeTarget: null },
      };
    }

    // Phase 233: run the real provider health check before advancing to ACTIVE.
    // Never transition to ACTIVE merely because cutover returned ok.
    let healthVerdict: "HEALTHY" | "UNHEALTHY" | "UNKNOWN" | "BLOCKED" = "UNKNOWN";
    let healthReason: string | null = null;
    if (cutoverTarget) {
      try {
        const h = await this.router.health(cutoverTarget);
        healthVerdict = h.verdict;
        healthReason = h.reason;
      } catch (e) {
        healthVerdict = "UNKNOWN";
        healthReason = "health_threw:" + (e instanceof Error ? e.message : String(e));
      }
    } else {
      healthReason = "no cutover target to verify";
    }

    if (healthVerdict !== "HEALTHY") {
      const reasonText = "POST_CUTOVER_HEALTH_" + healthVerdict + (healthReason ? ":" + healthReason : "");
      await this.intents.transitionIfOwnedAsync(
        intentKey, "ACTIVATION_FAILED" as ReleaseIntentStatus, workerId,
        {
          failureReason: reasonText,
          provider: this.router.kind,
          providerStatus: healthVerdict,
          providerDeploymentId: cutoverTarget,
          reconciledAt: Date.now(),
        },
        ["TRAFFIC_CUTOVER"],
      );
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
      return {
        status: "BLOCKED",
        reason: reasonText,
        intent: finalIntent,
        previousTarget: capturedPreviousTarget,
        cutover: { attempted: true, ok: true, reason: null, activeTarget: cutoverTarget },
      };
    }

    const postHealthEvidence = JSON.stringify({
      source: "DeploymentActivationService.activate.POST_ACTIVATION_HEALTH_CHECK",
      intentKey,
      releaseId: current.releaseId,
      environment: current.environment,
      cutoverTarget,
      previousTarget: capturedPreviousTarget?.deploymentId ?? null,
      healthVerdict,
      workerId,
      timestamp: Date.now(),
    });

    const t4 = await this.intents.transitionIfOwnedAsync(
      intentKey, "POST_ACTIVATION_HEALTH_CHECK" as ReleaseIntentStatus, workerId,
      {
        provider: this.router.kind,
        providerStatus: healthVerdict,
        providerDeploymentId: cutoverTarget,
        reconciledAt: Date.now(),
        reconciliationEvidence: postHealthEvidence,
      },
      ["TRAFFIC_CUTOVER"],
    );
    if (!t4.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
      return { status: "FAILED", reason: "POST_CUTOVER_TRANSITION_REFUSED", intent: finalIntent,
               previousTarget: capturedPreviousTarget,
               cutover: { attempted: true, ok: true, reason: null, activeTarget: cutoverTarget } };
    }

    const activeEvidence = JSON.stringify({
      source: "DeploymentActivationService.activate.ACTIVE",
      intentKey,
      releaseId: current.releaseId,
      environment: current.environment,
      cutoverTarget,
      previousTarget: capturedPreviousTarget?.deploymentId ?? null,
      healthVerdict,
      workerId,
      timestamp: Date.now(),
    });

    await this.intents.transitionIfOwnedAsync(
      intentKey, "ACTIVE" as ReleaseIntentStatus, workerId,
      {
        provider: this.router.kind,
        providerStatus: "ACTIVE",
        providerDeploymentId: cutoverTarget,
        reconciledAt: Date.now(),
        reconciliationEvidence: activeEvidence,
      },
      ["POST_ACTIVATION_HEALTH_CHECK"],
    );
    await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);

    const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
    return {
      status: "ACTIVATED",
      reason: null,
      intent: finalIntent,
      previousTarget: capturedPreviousTarget,
      cutover: { attempted: true, ok: true, reason: null, activeTarget: cutoverTarget },
    };
  }
  async rollback(intentKey: string, workerId: string): Promise<ActivationResult> {
    if (!this.intents) {
      return { status: "BLOCKED", reason: "NO_INTENT_SERVICE", intent: null,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    const current = await this.intents.getAsync(intentKey);
    if (!current) {
      return { status: "BLOCKED", reason: "INTENT_NOT_FOUND", intent: null,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    if (current.status !== "ACTIVE" && current.status !== "HEALTH_DEGRADED") {
      return { status: "BLOCKED", reason: "INTENT_NOT_ACTIVE:" + current.status, intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const lease = await this.intents.acquireLeaseAsync(intentKey, workerId);
    if (!lease.acquired) {
      return { status: "BLOCKED", reason: "ROLLBACK_LEASE_HELD:" + (lease.holder ?? "unknown"), intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const t1 = await this.intents.transitionIfOwnedAsync(
      intentKey, "ROLLBACK_REQUESTED" as ReleaseIntentStatus, workerId, {}, [current.status],
    );
    if (!t1.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      return { status: "BLOCKED", reason: "TRANSITION_ROLLBACK_REQUESTED_REFUSED", intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }

    const t2 = await this.intents.transitionIfOwnedAsync(
      intentKey, "ROLLING_BACK" as ReleaseIntentStatus, workerId, {}, ["ROLLBACK_REQUESTED"],
    );
    if (!t2.updated) {
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      return { status: "BLOCKED", reason: "TRANSITION_ROLLING_BACK_REFUSED", intent: current,
               cutover: { attempted: false, ok: false, reason: null, activeTarget: null } };
    }
    // Phase 230: previous target group ARN is required for a real revert.
    const previousTargetGroupArn = process.env.NEXUS_AWS_PREVIOUS_TARGET_GROUP_ARN || null;
    const awsRouting = previousTargetGroupArn
      ? {
          loadBalancerArn: process.env.NEXUS_AWS_LOAD_BALANCER_ARN || null,
          listenerArn: process.env.NEXUS_AWS_LISTENER_ARN || null,
          ruleArn: process.env.NEXUS_AWS_RULE_ARN || null,
          candidateTargetGroupArn: null,
          previousTargetGroupArn,
          targetId: null,
          targetPort: process.env.NEXUS_AWS_TARGET_PORT
            ? Number(process.env.NEXUS_AWS_TARGET_PORT)
            : null,
        }
      : undefined;

    const req: CutoverRequest = {
      environment: current.environment,
      intentKey,
      releaseId: current.releaseId,
      commitSha: current.commitSha,
      imageRepository: current.imageRepository,
      imageTag: current.imageTag,
      imageId: current.imageId ?? null,
      imageDigest: current.imageDigest ?? null,
      containerName: current.containerName,
      containerPort: current.containerPort,
      previousContainerName: null,
      aws: awsRouting,
    };

    let revertOk = false;
    let revertReason: string | null = null;
    try {
      const r = await this.router.revert(req);
      revertOk = r.ok;
      revertReason = r.reason;
    } catch (e) {
      revertOk = false;
      revertReason = "router_threw:" + (e instanceof Error ? e.message : String(e));
    }

    if (!revertOk) {
      await this.intents.transitionIfOwnedAsync(
        intentKey, "ACTIVATION_FAILED" as ReleaseIntentStatus, workerId,
        { failureReason: revertReason ?? NO_TRAFFIC_ROUTER_REASON }, ["ROLLING_BACK"],
      );
      await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);
      const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
      return {
        status: "BLOCKED",
        reason: revertReason ?? NO_TRAFFIC_ROUTER_REASON,
        intent: finalIntent,
        cutover: { attempted: true, ok: false, reason: revertReason, activeTarget: null },
      };
    }

    await this.intents.transitionIfOwnedAsync(
      intentKey, "TRAFFIC_RESTORED" as ReleaseIntentStatus, workerId, {}, ["ROLLING_BACK"],
    );
    await this.intents.transitionIfOwnedAsync(
      intentKey, "FAILED" as ReleaseIntentStatus, workerId, {}, ["TRAFFIC_RESTORED"],
    );
    await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);

    const finalIntent = (await this.intents.getAsync(intentKey)) ?? current;
    return {
      status: "ACTIVATED",
      reason: null,
      intent: finalIntent,
      cutover: { attempted: true, ok: true, reason: null, activeTarget: null },
    };
  }

  /**
   * Phase 234: observe the health of an already-ACTIVE deployment using the
   * existing TrafficRouter.health() capability. Never manufactures ACTIVE.
   * Preserves UNKNOWN / BLOCKED verdicts without falsifying them.
   * ACTIVE + UNHEALTHY -> HEALTH_DEGRADED via the existing fenced CAS.
   */
  async observeActiveHealth(
    intentKey: string,
    workerId: string,
  ): Promise<ActiveHealthObservationResult> {
    const observedAt = Date.now();
    if (!this.intents) {
      return { status: "BLOCKED", verdict: null, reason: "NO_INTENT_SERVICE",
               intent: null, providerTargetId: null, observedAt, transitionedTo: null };
    }

    const current = await this.intents.getAsync(intentKey);
    if (!current) {
      return { status: "BLOCKED", verdict: null, reason: "INTENT_NOT_FOUND",
               intent: null, providerTargetId: null, observedAt, transitionedTo: null };
    }
    if (current.status !== "ACTIVE") {
      return { status: "NOT_ACTIVE", verdict: null,
               reason: "INTENT_NOT_ACTIVE:" + current.status,
               intent: current, providerTargetId: null, observedAt, transitionedTo: null };
    }

    const lease = await this.intents.acquireLeaseAsync(intentKey, workerId);
    if (!lease.acquired) {
      return { status: "BLOCKED", verdict: null,
               reason: "OBSERVATION_LEASE_HELD:" + (lease.holder ?? "unknown"),
               intent: current, providerTargetId: null, observedAt, transitionedTo: null };
    }

    const providerTargetId = current.providerDeploymentId ?? null;
    let verdict: RouterHealthVerdict = "UNKNOWN";
    let hReason: string | null = null;

    if (providerTargetId) {
      try {
        const h = await this.router.health(providerTargetId);
        verdict = h.verdict;
        hReason = h.reason;
      } catch (e) {
        verdict = "UNKNOWN";
        hReason = "health_threw:" + (e instanceof Error ? e.message : String(e));
      }
    } else {
      hReason = "NO_PROVIDER_TARGET_BOUND";
    }

    const evidence = JSON.stringify({
      source: "DeploymentActivationService.observeActiveHealth",
      intentKey,
      releaseId: current.releaseId,
      executionId: current.executionId,
      deploymentId: current.deploymentId ?? null,
      environment: current.environment,
      commitSha: current.commitSha,
      provider: this.router.kind,
      providerTargetId,
      verdict,
      providerReason: hReason,
      previousStatus: "ACTIVE",
      workerId,
      observedAt,
    });

    const nextStatus: ReleaseIntentStatus =
      verdict === "UNHEALTHY" ? "HEALTH_DEGRADED" : "ACTIVE";

    const t = await this.intents.transitionIfOwnedAsync(
      intentKey,
      nextStatus,
      workerId,
      {
        provider: this.router.kind,
        providerStatus: verdict,
        providerDeploymentId: providerTargetId,
        reconciledAt: observedAt,
        reconciliationEvidence: evidence,
      },
      ["ACTIVE"],
    );

    await this.intents.releaseLeaseAsync(intentKey, workerId).catch(() => undefined);

    if (!t.updated) {
      const reloaded = (await this.intents.getAsync(intentKey)) ?? current;
      return { status: "BLOCKED", verdict,
               reason: "OBSERVATION_TRANSITION_REFUSED",
               intent: reloaded, providerTargetId, observedAt, transitionedTo: null };
    }

    return {
      status: "OBSERVED",
      verdict,
      reason: hReason,
      intent: t.intent ?? null,
      providerTargetId,
      observedAt,
      transitionedTo: nextStatus,
    };
  }
}
