// src/core/deployment-orchestrator.ts
//
// Canonical production deployment orchestration. Turns an immutable Docker
// image into a real running container, verifies the running image identity
// via `docker inspect`, resolves the actual mapped host port, runs real
// health + Playwright smoke through SmokeTestService, and only marks
// KNOWN_GOOD when identity + health + smoke all genuinely PASS.
//
// On verification failure, delegates rollback to the existing RollbackAgent.
//
// All Docker operations flow through the RuntimeBridge's DockerAdapter and
// its hardened ProcessExecutor. No child_process.spawn, no shell.
//
// Every Docker/Playwright call must carry a workspace_token (the host bridge
// enforces this). To achieve that without mutating the shared RuntimeBridge,
// the orchestrator accepts an optional "binder" that materializes a
// workspace, wraps the raw executor in a TokenBoundExecutor, and hands back
// token-bound DockerAdapter + SmokeTestService for the deployment. When the
// binder is not supplied (unit tests), the injected adapters are used as-is.

import type { DockerAdapter, ProcessExecutor, RuntimeBridgeServices, SmokeTestService } from "./runtime";
import { TokenBoundExecutor, DockerAdapter as DockerAdapterCtor, PlaywrightAdapter, SmokeTestService as SmokeTestServiceCtor } from "./runtime";
import type { DeploymentRecord, DeploymentCheckStatus, RollbackResult } from "./types";
import { DeploymentHistoryService } from "./deployment-history";
import { RollbackAgent } from "./rollback";

/* ---------------------------- request / outcome ---------------------------- */

export interface CanonicalDeploymentRequest {
  project_id: string;
  environment: string;
  release_id: string;
  commit_sha?: string | null;
  artifact_id?: string | null;
  image_repository: string;
  image_tag: string;
  image_id?: string | null;
  image_digest?: string | null;
  container_name: string;
  container_port: number;
  container_host_port?: number;
  execution_id?: string | null;
}

export interface CanonicalDeploymentOutcome {
  deployment: DeploymentRecord;
  rollback: RollbackResult | null;
}

/** A deployment-scoped, token-bound runtime view. */
export interface BoundRuntime {
  docker: DockerAdapter;
  smoke: SmokeTestService;
  cleanup: () => Promise<void>;
}

/** Materializes a workspace and returns token-bound adapters. */
export type RuntimeBinder = () => Promise<BoundRuntime>;

/* --------------------------------- class ----------------------------------- */

export class CanonicalDeploymentOrchestrator {
  private readonly history: DeploymentHistoryService;
  private readonly agent: RollbackAgent;

  constructor(
    history: DeploymentHistoryService,
    private readonly docker: DockerAdapter,
    private readonly smoke: SmokeTestService,
    private readonly svc: RuntimeBridgeServices,
    private readonly binder?: RuntimeBinder,
  ) {
    this.history = history;
    this.agent = new RollbackAgent(docker, smoke, history, svc);
  }

  async deploy(req: CanonicalDeploymentRequest): Promise<CanonicalDeploymentOutcome> {
    if (req.image_tag === "latest") {
      throw new Error("Refusing to deploy :latest — an immutable tag or digest is required");
    }

    // Bind a token-scoped runtime for this deployment when a binder exists.
    let docker = this.docker;
    let smoke = this.smoke;
    let agent = this.agent;
    let cleanup: (() => Promise<void>) | null = null;
    if (this.binder) {
      const bound = await this.binder();
      docker = bound.docker;
      smoke = bound.smoke;
      agent = new RollbackAgent(bound.docker, bound.smoke, this.history, this.svc);
      cleanup = bound.cleanup;
    }

    try {
      return await this.runDeploy(req, docker, smoke, agent);
    } finally {
      if (cleanup) await cleanup().catch(() => undefined);
    }
  }

  private async runDeploy(
    req: CanonicalDeploymentRequest,
    docker: DockerAdapter,
    smoke: SmokeTestService,
    agent: RollbackAgent,
  ): Promise<CanonicalDeploymentOutcome> {

    /* (2) require immutable identity */
    if (!req.image_id && !req.image_digest) {
      const rec = await this.history.createDeployment({
        project_id: req.project_id, environment: req.environment, release_id: req.release_id,
        image_repository: req.image_repository, image_tag: req.image_tag,
        image_id: null, image_digest: null,
        commit_sha: req.commit_sha ?? null, container_name: req.container_name,
        previous_deployment_id: null, is_rollback: false,
      });
      await this.history.setStatus(rec.id, "BLOCKED");
      await this.history.updateDeployment(rec.id, {
        failure_reason: "no immutable image identity available (image_id and image_digest both missing)",
        completed_at: Date.now(),
      });
      await this.svc.events.emit({
        type: "deployment.blocked" as never, source: "CanonicalDeploymentOrchestrator",
        execution_id: req.execution_id ?? null,
        payload: { reason: "no immutable image identity", image_repository: req.image_repository, image_tag: req.image_tag },
      });
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }

    /* (3) create DEPLOYING record */
    const rec = await this.history.createDeployment({
      project_id: req.project_id, environment: req.environment, release_id: req.release_id,
      image_repository: req.image_repository, image_tag: req.image_tag,
      image_id: req.image_id ?? null, image_digest: req.image_digest ?? null,
      commit_sha: req.commit_sha ?? null, container_name: req.container_name,
      previous_deployment_id: null, is_rollback: false,
    });
    if (req.artifact_id) await this.history.updateDeployment(rec.id, { artifact_id: req.artifact_id });
    await this.history.setStatus(rec.id, "DEPLOYING");
    await this.svc.events.emit({
      type: "deployment.started" as never, source: "CanonicalDeploymentOrchestrator",
      execution_id: req.execution_id ?? null,
      payload: { deployment_id: rec.id, image: req.image_repository + ":" + req.image_tag, environment: req.environment },
    });

    /* (4) stop/remove any existing container with the same name */
    await docker.run({ kind: "stop", container: req.container_name }).catch(() => undefined);
    await docker.run({ kind: "rm", container: req.container_name, force: true }).catch(() => undefined);

    /* (5) run the real container */
    const runRes = await docker.run({
      kind: "run",
      image: req.image_digest ? req.image_repository + "@" + req.image_digest : req.image_repository + ":" + req.image_tag,
      name: req.container_name,
      ports: [{ host: req.container_host_port ?? 0, container: req.container_port }],
      detach: true,
    });
    if (runRes.status === "BLOCKED") {
      await this.history.setStatus(rec.id, "BLOCKED");
      await this.history.updateDeployment(rec.id, {
        failure_reason: "docker unavailable: " + (runRes.blocked_reason ?? "host executor unavailable"),
        completed_at: Date.now(),
      });
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }
    if (runRes.status !== "SUCCEEDED") {
      await this.history.markFailed(rec.id, "docker run failed (exit " + runRes.exit_code + "): " + runRes.stderr.slice(0, 200));
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }
    const containerId = runRes.stdout.trim().split("\n").pop()?.trim() || null;
    if (!containerId) {
      await this.history.markFailed(rec.id, "docker run returned no container id");
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }
    await this.history.updateDeployment(rec.id, { container_id: containerId });

    /* (6) inspect the running container */
    const inspectRes = await docker.run({ kind: "inspect", image: containerId });
    if (inspectRes.status !== "SUCCEEDED") {
      await this.history.markFailed(rec.id, "docker inspect failed: " + inspectRes.stderr.slice(0, 200));
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }
    let runningImageId: string | null = null;
    let hostPort: number | null = null;
    try {
      const doc = JSON.parse(inspectRes.stdout) as {
        Image?: string;
        NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
      }[];
      if (Array.isArray(doc) && doc.length > 0) {
        runningImageId = doc[0].Image ?? null;
        const mapped = doc[0].NetworkSettings?.Ports?.[req.container_port + "/tcp"]?.[0]?.HostPort;
        hostPort = mapped ? Number(mapped) : null;
      }
    } catch { /* leave nulls */ }

    /* (7) resolve expected image id */
    let expectedImageId: string | null = req.image_id ?? null;
    if (!expectedImageId && req.image_digest) {
      expectedImageId = await this.resolveImageId(req.image_repository + "@" + req.image_digest, docker);
    }

    /* (8) identity verification */
    const identityMatches = !!expectedImageId && !!runningImageId && runningImageId === expectedImageId;
    if (!identityMatches) {
      await this.history.setChecks(rec.id, { quality_gate: "FAIL" });
      await this.history.markFailed(rec.id,
        "running container image id mismatch: running=" + (runningImageId ?? "unknown") + " expected=" + (expectedImageId ?? "unknown"));
      const rb = await this.attemptRollback(req, agent);
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: rb };
    }

    /* (9) URL */
    if (!hostPort) {
      await this.history.setStatus(rec.id, "BLOCKED");
      await this.history.updateDeployment(rec.id, {
        failure_reason: "could not resolve mapped host port from docker inspect (NetworkSettings.Ports empty for " + req.container_port + "/tcp)",
        completed_at: Date.now(),
      });
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }
    const url = "http://127.0.0.1:" + hostPort;
    await this.history.updateDeployment(rec.id, { url });

    /* (10) real health + Playwright smoke */
    await this.history.setStatus(rec.id, "HEALTH_CHECKING");
    const verification = await smoke.run({ execution_id: req.execution_id ?? null, staging_url: url });
    const health: DeploymentCheckStatus =
      verification.health.ok ? "PASS"
        : verification.health.error && !verification.health.status_code ? "BLOCKED" : "FAIL";
    const smokeStatus: DeploymentCheckStatus =
      verification.smoke.status === "PASSED" ? "PASS"
        : verification.smoke.status === "BLOCKED" ? "BLOCKED" : "FAIL";
    const quality: DeploymentCheckStatus =
      verification.verdict === "PASS" ? "PASS"
        : verification.verdict === "BLOCKED" ? "BLOCKED" : "FAIL";
    await this.history.setChecks(rec.id, { health_status: health, smoke_status: smokeStatus, quality_gate: quality });

    /* (11) BLOCKED branch */
    if (health === "BLOCKED" || smokeStatus === "BLOCKED") {
      await this.history.setStatus(rec.id, "BLOCKED");
      await this.history.updateDeployment(rec.id, {
        failure_reason: "verification BLOCKED (health=" + health + " smoke=" + smokeStatus + ") — required capability unavailable",
        completed_at: Date.now(),
      });
      await this.svc.events.emit({
        type: "deployment.blocked" as never, source: "CanonicalDeploymentOrchestrator",
        execution_id: req.execution_id ?? null,
        payload: { deployment_id: rec.id, health, smoke: smokeStatus },
      });
      return { deployment: (await this.history.getDeployment(rec.id))!, rollback: null };
    }

    /* (12) KNOWN_GOOD when identity + health + smoke all PASS */
    if (identityMatches && health === "PASS" && smokeStatus === "PASS") {
      const known = await this.history.markKnownGood(rec.id);
      await this.svc.events.emit({
        type: "deployment.verified" as never, source: "CanonicalDeploymentOrchestrator",
        execution_id: req.execution_id ?? null,
        payload: { deployment_id: rec.id, url, image_id: runningImageId },
      });
      return { deployment: known ?? (await this.history.getDeployment(rec.id))!, rollback: null };
    }

    /* (13) failed verification → rollback */
    await this.history.markFailed(rec.id,
      "verification incomplete (health=" + health + " smoke=" + smokeStatus + " quality=" + quality + ")");
    const rb = await this.attemptRollback(req, agent);
    return { deployment: (await this.history.getDeployment(rec.id))!, rollback: rb };
  }

  private async resolveImageId(ref: string, docker: DockerAdapter): Promise<string | null> {
    const r = await docker.run({ kind: "inspect", image: ref });
    if (r.status !== "SUCCEEDED") return null;
    try {
      const doc = JSON.parse(r.stdout) as { Id?: string }[];
      if (Array.isArray(doc) && doc.length > 0 && typeof doc[0].Id === "string") return doc[0].Id;
      return null;
    } catch { return null; }
  }

  private async attemptRollback(req: CanonicalDeploymentRequest, agent: RollbackAgent): Promise<RollbackResult> {
    await this.svc.events.emit({
      type: "rollback.invoked" as never, source: "CanonicalDeploymentOrchestrator",
      execution_id: req.execution_id ?? null,
      payload: { project_id: req.project_id, environment: req.environment },
    });
    return await agent.rollback(req.project_id, req.environment, req.execution_id ?? null, {
      containerName: req.container_name,
      containerPort: req.container_port,
    });
  }
}
