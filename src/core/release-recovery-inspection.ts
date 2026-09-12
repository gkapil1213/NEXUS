// src/core/release-recovery-inspection.ts
// Phase 104: pure Docker inspection helper for crash recovery.
//
// Given a durable ReleaseDeploymentIntent and a DockerAdapter, determine whether
// the intended container is running, whether its immutable image identity
// matches the intent, and the mapped host URL if any.
//
// This module has NO side effects. It never transitions intent state, never
// acquires a lease, and never deploys. It only reads real Docker state.

import type { ReleaseDeploymentIntent } from "./execution-store";
import type { DockerAdapter } from "./runtime";

export type InspectionVerdict =
  | "MATCHES_INTENT"    // container exists; running image id === expected
  | "IDENTITY_MISMATCH" // container exists; running image id !== expected
  | "MISSING"           // container does not exist (or docker inspect failed)
  | "BLOCKED";          // host executor unavailable / inspect returned BLOCKED

export interface InspectionResult {
  verdict: InspectionVerdict;
  containerId: string | null;
  runningImageId: string | null;
  expectedImageId: string | null;
  hostPort: number | null;
  url: string | null;
  reason: string | null;
}

interface DockerInspectDoc {
  Id?: string;
  Image?: string;
  NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
}

/**
 * Inspect the intent's container and classify against its immutable identity.
 *
 * Order of operations:
 *   1. docker inspect <containerName>
 *   2. If BLOCKED -> return BLOCKED (host executor unavailable)
 *   3. If not SUCCEEDED -> return MISSING (container absent or inspect failed)
 *   4. Parse: running Image id + mapped host port for intent.containerPort
 *   5. Resolve expected image id:
 *        - prefer intent.imageId when present
 *        - otherwise resolve repository@imageDigest via docker inspect
 *   6. Compare: MATCHES_INTENT / IDENTITY_MISMATCH
 *
 * Never fabricates a container id or a matching verdict.
 */
export async function inspectIntentContainer(
  intent: ReleaseDeploymentIntent,
  docker: DockerAdapter,
): Promise<InspectionResult> {
  const inspect = await docker.run({ kind: "inspect", image: intent.containerName });

  if (inspect.status === "BLOCKED") {
    return {
      verdict: "BLOCKED",
      containerId: null,
      runningImageId: null,
      expectedImageId: null,
      hostPort: null,
      url: null,
      reason: inspect.blocked_reason ?? "host executor unavailable",
    };
  }

  if (inspect.status !== "SUCCEEDED") {
    const detail = (inspect.stderr || inspect.stdout || "").slice(0, 300);
    const confirmedMissing =
      inspect.status === "FAILED" &&
      /no such (?:object|container)|(?:container|object).*not found/i.test(detail);

    if (confirmedMissing) {
      return {
        verdict: "MISSING",
        containerId: null,
        runningImageId: null,
        expectedImageId: null,
        hostPort: null,
        url: null,
        reason:
          "docker confirms container " + intent.containerName + " is missing: " + detail,
      };
    }

    return {
      verdict: "BLOCKED",
      containerId: null,
      runningImageId: null,
      expectedImageId: null,
      hostPort: null,
      url: null,
      reason:
        "docker inspect failed ambiguously (exit " + inspect.exit_code + "): " + detail,
    };
  }

  let doc: DockerInspectDoc | null = null;
  try {
    const parsed = JSON.parse(inspect.stdout) as DockerInspectDoc[] | DockerInspectDoc;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") doc = first;
  } catch {
    doc = null;
  }

  if (!doc) {
    return {
      verdict: "BLOCKED",
      containerId: null,
      runningImageId: null,
      expectedImageId: null,
      hostPort: null,
      url: null,
      reason: "docker inspect succeeded but output could not be parsed as JSON",
    };
  }

  const containerId = typeof doc.Id === "string" ? doc.Id : null;
  const runningImageId = typeof doc.Image === "string" ? doc.Image : null;
  const mapped = doc.NetworkSettings?.Ports?.[intent.containerPort + "/tcp"]?.[0]?.HostPort;
  const hostPort = mapped ? Number(mapped) : null;
  const url = hostPort ? "http://127.0.0.1:" + hostPort : null;

  const expectedImageId = await resolveExpectedImageId(intent, docker);

  if (!expectedImageId) {
    return {
      verdict: "BLOCKED",
      containerId,
      runningImageId,
      expectedImageId: null,
      hostPort,
      url,
      reason:
        "cannot resolve expected image id: intent.imageId is null and digest "
        + intent.imageDigest + " could not be resolved to an image id",
    };
  }

  if (runningImageId === expectedImageId) {
    return {
      verdict: "MATCHES_INTENT",
      containerId,
      runningImageId,
      expectedImageId,
      hostPort,
      url,
      reason: null,
    };
  }

  return {
    verdict: "IDENTITY_MISMATCH",
    containerId,
    runningImageId,
    expectedImageId,
    hostPort,
    url,
    reason:
      "running container image id does not match intent: running=" + (runningImageId ?? "unknown")
      + " expected=" + expectedImageId,
  };
}

async function resolveExpectedImageId(
  intent: ReleaseDeploymentIntent,
  docker: DockerAdapter,
): Promise<string | null> {
  if (intent.imageId) return intent.imageId;
  if (!intent.imageDigest || !intent.imageRepository) return null;

  // Try the immutable digest reference first.
  const ref = intent.imageRepository + "@" + intent.imageDigest;
  const r = await docker.run({ kind: "inspect", image: ref });
  if (r.status !== "SUCCEEDED") return null;
  try {
    const doc = JSON.parse(r.stdout) as { Id?: string }[] | { Id?: string };
    const first = Array.isArray(doc) ? doc[0] : doc;
    return typeof first?.Id === "string" ? first.Id : null;
  } catch {
    return null;
  }
}