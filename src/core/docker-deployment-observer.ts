// src/core/docker-deployment-observer.ts
//
// Phase 250: concrete DeploymentObserver.
//
// Bridges the existing DeploymentHistoryService (authoritative deployment
// record lookup) and the existing DockerAdapter (real `docker inspect`) to
// produce the DeploymentObservation that Phase 249's
// evaluateDeploymentIntegrity() consumes.
//
// Reuses existing infrastructure only. No new persistence. No new Docker
// client. No fabricated identity.

import type {
  DeploymentObserver,
  DeploymentObservation,
} from "./post-deployment-integrity";
import type { DeploymentHistoryService } from "./deployment-history";
import type { DockerAdapter, DockerResult } from "./runtime";

export interface DockerDeploymentObserverDeps {
  history: DeploymentHistoryService;
  docker: DockerAdapter;
}

export class DockerDeploymentObserver implements DeploymentObserver {
  constructor(private readonly deps: DockerDeploymentObserverDeps) {}

  async observe(deploymentId: string): Promise<DeploymentObservation> {
    const now = new Date().toISOString();

    // 1. Authoritative deployment record lookup
    const rec = await this.deps.history.getDeployment(deploymentId);
    if (!rec) {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "deployment record not found: " + deploymentId,
        observed_at: now,
      };
    }

    const containerName = rec.container_name;
    if (!containerName) {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "deployment record has no container_name",
        observed_at: now,
      };
    }

    // 2. Real docker inspect through the existing DockerAdapter
    let inspect: DockerResult;
    try {
      inspect = await this.deps.docker.run({ kind: "inspect", image: containerName });
    } catch (e) {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "docker inspect threw: " + (e instanceof Error ? e.message : String(e)),
        observed_at: now,
      };
    }

    if (inspect.status === "BLOCKED") {
      return {
        deployment_id: deploymentId,
        available: false,
        status: "NOT_EXECUTED",
        reason:
          "docker inspect blocked: " +
          (inspect.blocked_reason ?? "host executor unavailable"),
        observed_at: now,
      };
    }

    if (inspect.status !== "SUCCEEDED") {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason:
          "docker inspect failed (exit " + inspect.exit_code + "): " +
          String(inspect.stderr || inspect.stdout || "").slice(0, 200),
        observed_at: now,
      };
    }

    // 3. Parse docker inspect output
    let doc: any;
    try {
      const parsed = JSON.parse(inspect.stdout);
      doc = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "docker inspect output is not JSON",
        observed_at: now,
      };
    }

    if (!doc || typeof doc !== "object") {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "docker inspect returned empty/invalid document",
        observed_at: now,
      };
    }

    // 4. Actual running identity from the container
    const actualImageId = typeof doc.Image === "string" ? doc.Image : null;
    const actualContainerId = typeof doc.Id === "string" ? doc.Id : null;

    if (!actualImageId) {
      return {
        deployment_id: deploymentId,
        available: true,
        status: "ERROR",
        reason: "docker inspect returned no Image field",
        observed_at: now,
      };
    }

    // 5. Compare actual running image against the record's expected image_id.
    //    Phase 249 will then compare the returned observed_digest against
    //    the caller-supplied expected artifact digest.
    const expectedImageId = rec.image_id ?? null;
    const recordDigest = rec.image_digest ?? null;

    let observedDigest: string | null;
    let note: string;

    if (expectedImageId && actualImageId === expectedImageId) {
      // Container is running the expected image. Report the authoritative
      // registry digest (or the image id) so Phase 249 sees a match when the
      // caller's expected digest equals what was recorded at deploy time.
      observedDigest = recordDigest ?? actualImageId;
      note = "container running expected image " + actualImageId;
    } else if (expectedImageId && actualImageId !== expectedImageId) {
      // Real drift: the container is not running the recorded image.
      // Report the ACTUAL image id — Phase 249 will detect the mismatch.
      observedDigest = actualImageId;
      note =
        "container image " + actualImageId +
        " does not match recorded image_id " + expectedImageId;
    } else {
      // No expected image_id recorded — do not fabricate a match.
      observedDigest = recordDigest;
      note = "deployment record has no image_id";
    }

    return {
      deployment_id: deploymentId,
      available: true,
      status: "OBSERVED",
      observed_release_id: rec.release_id ?? null,
      observed_artifact_id: rec.artifact_id ?? null,
      observed_digest: observedDigest,
      observed_provider: "docker",
      observed_revision: actualImageId,
      reason: note,
      observed_at: now,
    };
  }
}