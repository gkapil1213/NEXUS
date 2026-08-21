/**
 * NEXUS Phase 3 Pass 6E â€” Rollback + Deployment History.
 *
 * Composes the EXISTING runtime primitives â€” nothing here re-implements
 * container ops, health probes, smoke tests, events, audit or persistence:
 *
 *   RollbackAgent
 *       â†“ DockerAdapter (docker image inspect / ps / inspect / stop / rm / run)
 *       â†“ SmokeTestService (real HTTP health + Playwright smoke)
 *       â†“ DeploymentHistoryService (real IndexedDB persistence via NexusEngine)
 *       â†“ EventService / AuditService
 *
 * Rollback restores the PREVIOUS KNOWN_GOOD deployment's immutable image
 * identity. It NEVER rebuilds the image, NEVER uses `latest`, and NEVER
 * fabricates an identity: the restored container's image id is verified
 * against the stored known-good image_id via a REAL `docker inspect`.
 *
 * Every result comes from actual execution. When the host executor is
 * unavailable (managed browser runtime) every step honestly reports BLOCKED.
 */

import { nid } from "./db";
import type { DockerAdapter, DockerResult, RuntimeBridgeServices, SmokeTestService } from "./runtime";
import type { DeploymentRecord, RollbackResult, DeploymentCheckStatus } from "./types";
import { DeploymentHistoryService } from "./deployment-history";

export { DeploymentHistoryService };

/* ------------------------------- RollbackAgent ----------------------------- */

export interface RollbackOutcome extends RollbackResult {}

/**
 * Restores the previous KNOWN_GOOD deployment's immutable image. The previous
 * image is re-run by its stored immutable identity (digest > image_id >
 * repository:tag) â€” it is NEVER rebuilt. The restored container's image id is
 * verified against the known-good image_id via a real `docker inspect`.
 */
export class RollbackAgent {
  constructor(
    private docker: DockerAdapter,
    private smoke: SmokeTestService,
    private history: DeploymentHistoryService,
    private svc: RuntimeBridgeServices,
  ) {}

  private blocked(reason: string, extra: Partial<RollbackResult> = {}): RollbackOutcome {
    return {
      status: "BLOCKED",
      reason,
      from_deployment_id: null,
      to_deployment_id: null,
      restored_image_id: null,
      restored_release_id: null,
      rollback_deployment_id: null,
      running_image_id: null,
      running_container_id: null,
      identity_matches: false,
      health_status: null,
      smoke_status: null,
      quality_gate: null,
      completed_at: Date.now(),
      ...extra,
    };
  }

  /** The strongest immutable reference for an image, in priority order. */
  private imageRef(d: DeploymentRecord): string {
    if (d.image_digest) return d.image_digest;
    if (d.image_id) return d.image_id;
    return `${d.image_repository}:${d.image_tag}`;
  }

  async rollback(
    projectId: string,
    environment: string,
    executionId: string | null,
    opts: { containerName?: string; containerPort?: number } = {},
  ): Promise<RollbackOutcome> {
    const containerName = opts.containerName ?? "nexus-staging";
    const containerPort = opts.containerPort ?? 8080;

    await this.svc.events.emit({
      type: "rollback.started" as never,
      source: "RollbackAgent",
      execution_id: executionId,
      payload: { project_id: projectId, environment },
    });

    // 1. Current deployment.
    const current = await this.history.getCurrent(projectId, environment);
    if (!current) {
      return this.blocked("no current deployment found for this project/environment");
    }

    // 2. Previous known-good deployment.
    const target = await this.history.getPreviousKnownGood(projectId, environment, current.id);
    if (!target) {
      return this.blocked("no previous KNOWN_GOOD deployment available to restore", {
        from_deployment_id: current.id,
      });
    }
    if (!target.image_id && !target.image_digest) {
      return this.blocked("previous KNOWN_GOOD deployment has no immutable image identity", {
        from_deployment_id: current.id,
        to_deployment_id: target.id,
      });
    }

    const ref = this.imageRef(target);

    // 3. Verify the immutable image exists locally (never rebuild).
    const exists = await this.docker.run({ kind: "inspect", image: ref });
    if (exists.status === "BLOCKED") {
      return this.blocked(`docker unavailable: ${exists.blocked_reason ?? "host executor unavailable"}`, {
        from_deployment_id: current.id,
        to_deployment_id: target.id,
      });
    }
    if (exists.status !== "SUCCEEDED") {
      return this.blocked(`previous image ${ref} not found locally (exit ${exists.exit_code}) â€” cannot rebuild`, {
        from_deployment_id: current.id,
        to_deployment_id: target.id,
      });
    }

    // 4. Stop + remove the current (failed) container.
    await this.docker.run({ kind: "stop", container: current.container_name ?? containerName }).catch(() => undefined);
    await this.docker.run({ kind: "rm", container: current.container_name ?? containerName, force: true }).catch(() => undefined);

    // 5. Run the previous immutable image (dynamic port, detached).
    const run = await this.docker.run({
      kind: "run",
      image: ref,
      name: containerName,
      ports: [],
      detach: true,
    });
    if (run.status === "BLOCKED") {
      return this.blocked(`docker run unavailable: ${run.blocked_reason ?? "host executor unavailable"}`, {
        from_deployment_id: current.id,
        to_deployment_id: target.id,
      });
    }
    if (run.status !== "SUCCEEDED") {
      return this.blocked(`docker run of ${ref} failed (exit ${run.exit_code}): ${run.stderr.slice(0, 200)}`, {
        from_deployment_id: current.id,
        to_deployment_id: target.id,
      });
    }
    const newContainerId = run.stdout.trim().split("\n").pop()?.trim() || null;

    // 6. Resolve the real mapped host port + running image id via docker inspect.
    let hostPort: number | null = null;
    let runningImageId: string | null = null;
    if (newContainerId) {
      const inspected = await this.docker.run({ kind: "inspect", image: newContainerId });
      if (inspected.status === "SUCCEEDED") {
        try {
          const doc = JSON.parse(inspected.stdout) as {
            Image?: string;
            NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
          }[];
          if (Array.isArray(doc) && doc.length > 0) {
            runningImageId = doc[0].Image ?? null;
            const mapped = doc[0].NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
            hostPort = mapped ? Number(mapped) : null;
          }
        } catch {
          runningImageId = null;
        }
      }
    }

    // 7. Identity verification: running container image == known-good image_id.
    const identityMatches = !!runningImageId && !!target.image_id && runningImageId === target.image_id;

    // 8. Real health + smoke against the restored deployment.
    const url = hostPort ? `http://127.0.0.1:${hostPort}` : null;
    let health: DeploymentCheckStatus = "BLOCKED";
    let smoke: DeploymentCheckStatus = "BLOCKED";
    let quality: DeploymentCheckStatus = "BLOCKED";
    if (url) {
      const verification = await this.smoke.run({ execution_id: executionId, staging_url: url });
      health = verification.health.ok ? "PASS" : verification.health.error && !verification.health.status_code ? "BLOCKED" : "FAIL";
      smoke = verification.smoke.status === "PASSED" ? "PASS" : verification.smoke.status === "BLOCKED" ? "BLOCKED" : "FAIL";
      quality = verification.verdict === "PASS" ? "PASS" : verification.verdict === "BLOCKED" ? "BLOCKED" : "FAIL";
    }

    // 9. Record the rollback deployment.
    const rollbackRec: DeploymentRecord = {
      id: nid("dep"),
      project_id: projectId,
      environment,
      release_id: target.release_id,
      artifact_id: target.artifact_id,
      image_repository: target.image_repository,
      image_tag: target.image_tag,
      image_id: target.image_id,
      image_digest: target.image_digest,
      commit_sha: target.commit_sha,
      container_id: newContainerId,
      container_name: containerName,
      url,
      status: identityMatches && health === "PASS" && smoke === "PASS" ? "KNOWN_GOOD" : "FAILED",
      health_status: health,
      smoke_status: smoke,
      quality_gate: quality,
      verified: identityMatches && health === "PASS" && smoke === "PASS",
      is_rollback: true,
      failure_injected: false,
      previous_deployment_id: current.id,
      failure_reason: identityMatches ? null : "restored container image identity did not match known-good image",
      started_at: Date.now(),
      completed_at: Date.now(),
    };
    await this.history.recordDeployment(rollbackRec);

    const verified = identityMatches && health === "PASS" && smoke === "PASS";
    const result: RollbackOutcome = {
      status: verified ? "VERIFIED" : runningImageId === null && health === "BLOCKED" ? "BLOCKED" : "FAILED",
      reason: verified
        ? null
        : !identityMatches
          ? `identity mismatch: running=${runningImageId ?? "unknown"} expected=${target.image_id ?? "unknown"}`
          : `verification incomplete (health=${health} smoke=${smoke})`,
      from_deployment_id: current.id,
      to_deployment_id: target.id,
      restored_image_id: target.image_id,
      restored_release_id: target.release_id,
      rollback_deployment_id: rollbackRec.id,
      running_image_id: runningImageId,
      running_container_id: newContainerId,
      identity_matches: identityMatches,
      health_status: health,
      smoke_status: smoke,
      quality_gate: quality,
      completed_at: Date.now(),
    };

    await this.svc.events.emit({
      type: (verified ? "rollback.verified" : "rollback.failed") as never,
      source: "RollbackAgent",
      execution_id: executionId,
      payload: {
        from: current.id,
        to: target.id,
        image_ref: ref,
        running_image_id: runningImageId,
        identity_matches: identityMatches,
        health,
        smoke,
      },
    });
    await this.svc.audit.record({
      actor: "system",
      action: verified ? "rollback.verified" : "rollback.failed",
      resource_type: "rollback",
      resource_id: rollbackRec.id,
      result: verified ? "allow" : "error",
      metadata: {
        from_deployment: current.id,
        to_deployment: target.id,
        image_ref: ref,
        running_image_id: runningImageId,
        identity_matches: identityMatches,
        health,
        smoke,
        reason: result.reason,
      },
    });

    return result;
  }
}

