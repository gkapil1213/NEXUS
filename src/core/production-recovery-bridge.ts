// src/core/production-recovery-bridge.ts
// Phase 251: production recovery-context bridge.
//
// Connects the authoritative persisted DeploymentRecord + ReleaseDeploymentIntent
// to the existing DriftRecoveryProviderContext consumed by
// requestDriftRecoveryIntent().
//
// This module does NOT execute rollback, acquire leases, or call Docker. It only
// assembles and validates the context and delegates to the existing
// requestDriftRecoveryIntent() and ReleaseDeploymentIntentService.
//
// If any authoritative field is missing or contradictory, returns BLOCKED with a
// precise reason. Never fabricates executionId, attemptId, imageId, imageDigest,
// containerName, containerPort, commitSha, or image identity.

import type { DeploymentRecord } from "./types";
import type { DeploymentHistoryService } from "./deployment-history";
import type { ReleaseDeploymentIntentService } from "./release-deployment-intent";
import type {
  DriftRecoveryProviderContext,
  DriftRecoveryIntentResult,
} from "./production-incident-response";
import { requestDriftRecoveryIntent } from "./production-incident-response";
import type { Incident } from "./observability-types";

export interface RecoveryIdentityExpectation {
  project_id: string;
  environment: string;
  release_id: string;
  artifact_id: string;
  artifact_digest: string;
}

export type RecoveryContextResult =
  | { status: "OK"; context: DriftRecoveryProviderContext; reason: string }
  | { status: "BLOCKED"; context: null; reason: string };

function isNonEmpty(v: string | null | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

function blocked(reason: string): RecoveryContextResult {
  return { status: "BLOCKED", context: null, reason };
}

export async function buildProductionRecoveryContext(input: {
  history: DeploymentHistoryService;
  deploymentId: string;
  expected: RecoveryIdentityExpectation;
}): Promise<RecoveryContextResult> {
  // Rule 1: deployment exists
  const dep: DeploymentRecord | null = await input.history.getDeployment(input.deploymentId);
  if (!dep) {
    return blocked("deployment not found: " + input.deploymentId);
  }

  // Rule 2: belongs to expected project / environment
  if (dep.project_id !== input.expected.project_id) {
    return blocked("project_id mismatch: record=" + String(dep.project_id) + " expected=" + input.expected.project_id);
  }
  if (dep.environment !== input.expected.environment) {
    return blocked("environment mismatch: record=" + String(dep.environment) + " expected=" + input.expected.environment);
  }

  // Rule 3: release_id matches
  if (!isNonEmpty(dep.release_id) || dep.release_id !== input.expected.release_id) {
    return blocked("release_id mismatch or missing: record=" + String(dep.release_id) + " expected=" + input.expected.release_id);
  }

  // Rule 4: artifact_id matches
  if (!isNonEmpty(dep.artifact_id) || dep.artifact_id !== input.expected.artifact_id) {
    return blocked("artifact_id mismatch or missing: record=" + String(dep.artifact_id) + " expected=" + input.expected.artifact_id);
  }

  // Rule 5: authoritative digest source exists and, when the caller supplies an
  // expected digest, it must match either the persisted image_digest or the
  // persisted image_id (docker sha256 id). Never accept an unverified digest.
  const depDigest = isNonEmpty(dep.image_digest) ? dep.image_digest : null;
  const depImageId = isNonEmpty(dep.image_id) ? dep.image_id : null;
  if (!depDigest && !depImageId) {
    return blocked("deployment record has no authoritative image_digest or image_id");
  }
  if (isNonEmpty(input.expected.artifact_digest)) {
    if (depDigest !== input.expected.artifact_digest && depImageId !== input.expected.artifact_digest) {
      return blocked(
        "expected artifact_digest does not match persisted image_digest/image_id: " +
        "expected=" + input.expected.artifact_digest +
        " dep_digest=" + String(depDigest) +
        " dep_image_id=" + String(depImageId),
      );
    }
  }

  // Rule 6: executionId authoritative
  if (!isNonEmpty(dep.execution_id)) {
    return blocked("deployment record has no authoritative execution_id");
  }

  // Rule 7: attemptId authoritative
  if (!isNonEmpty(dep.attempt_id)) {
    return blocked("deployment record has no authoritative attempt_id");
  }

  // Rule 8: container identity complete
  if (!isNonEmpty(dep.container_name)) {
    return blocked("deployment record has no container_name");
  }

  // Rule 9: containerPort authoritative
  if (typeof dep.container_port !== "number" || !Number.isFinite(dep.container_port) || dep.container_port <= 0) {
    return blocked("deployment record has no authoritative container_port");
  }

  // Rule 10: provider/image identity internally consistent
  if (!isNonEmpty(dep.image_repository) || !isNonEmpty(dep.image_tag)) {
    return blocked("deployment record image_repository/image_tag incomplete");
  }
  if (!isNonEmpty(dep.commit_sha)) {
    return blocked("deployment record has no commit_sha");
  }

  const imageDigest: string = isNonEmpty(dep.image_digest)
    ? dep.image_digest
    : input.expected.artifact_digest;

  const context: DriftRecoveryProviderContext = {
    executionId: dep.execution_id,
    attemptId: dep.attempt_id,
    commitSha: dep.commit_sha,
    imageRepository: dep.image_repository,
    imageTag: dep.image_tag,
    imageId: isNonEmpty(dep.image_id) ? dep.image_id : null,
    imageDigest,
    containerName: dep.container_name,
    containerPort: dep.container_port,
    projectId: dep.project_id ?? null,
  };

  return { status: "OK", context, reason: "context assembled from authoritative persisted deployment record" };
}

export async function requestRecoveryFromDeployment(input: {
  history: DeploymentHistoryService;
  intentService: ReleaseDeploymentIntentService;
  incident: Incident;
  deploymentId: string;
  expected: RecoveryIdentityExpectation;
}): Promise<DriftRecoveryIntentResult> {
  const built = await buildProductionRecoveryContext({
    history: input.history,
    deploymentId: input.deploymentId,
    expected: input.expected,
  });
  if (built.status !== "OK") {
    return { status: "BLOCKED", intentKey: null, reason: built.reason };
  }

  return await requestDriftRecoveryIntent({
    intentService: input.intentService,
    incident: input.incident,
    identity: {
      deployment_id: input.deploymentId,
      release_id: input.expected.release_id,
      artifact_id: input.expected.artifact_id,
      artifact_digest: input.expected.artifact_digest,
      environment: input.expected.environment,
    },
    providerContext: built.context,
  });
}