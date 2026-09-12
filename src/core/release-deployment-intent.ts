// src/core/release-deployment-intent.ts
// Phase 103: durable release deployment intent. Deterministic key from immutable
// inputs = natural idempotency. Lives in ExecutionStore (SQLite) for real
// durability across process restarts.

import type { ExecutionStore, ReleaseDeploymentIntent, ReleaseIntentStatus } from "./execution-store";

export interface ReleaseIntentInput {
  releaseId: string;
  executionId: string;
  artifactId: string;
  artifactDigest: string;
  commitSha: string;
  environment: string;
  imageRepository: string;
  imageTag: string;
  imageId: string | null;
  imageDigest: string;
  containerName: string;
  containerPort: number;
}

export interface AcquireResult {
  acquired: boolean;
  holder: string | null;
  expiresAt: number | null;
}

export const DEFAULT_LEASE_MS = 120_000;

export class ReleaseDeploymentIntentService {
  constructor(private readonly store: ExecutionStore) {}

  /** Deterministic key binding every immutable input. Same logical deploy = same key. */
  computeKey(input: ReleaseIntentInput): string {
    return [
      "intent",
      input.releaseId,
      input.executionId,
      input.artifactId,
      input.artifactDigest,
      input.commitSha,
      input.environment,
      input.imageRepository,
      input.imageTag,
      input.imageId ?? "",
      input.imageDigest,
    ].join("|");
  }

  /**
   * Idempotent. Two calls with identical inputs return the same intent.
   * `created=false` means an intent already existed (idempotent hit).
   * Never mutates an existing intent's immutable fields.
   */
  async getOrCreate(input: ReleaseIntentInput): Promise<{ intent: ReleaseDeploymentIntent; created: boolean }> {
    const intentKey = this.computeKey(input);
    return this.store.createReleaseIntentIdempotent({
      intentKey,
      releaseId: input.releaseId,
      executionId: input.executionId,
      artifactId: input.artifactId,
      artifactDigest: input.artifactDigest,
      commitSha: input.commitSha,
      environment: input.environment,
      imageRepository: input.imageRepository,
      imageTag: input.imageTag,
      imageId: input.imageId,
      imageDigest: input.imageDigest,
      containerName: input.containerName,
      containerPort: input.containerPort,
    });
  }

  get(intentKey: string): ReleaseDeploymentIntent | undefined {
    return this.store.getReleaseIntent(intentKey);
  }

  transition(
    intentKey: string,
    status: ReleaseIntentStatus,
    patch: { deploymentId?: string | null; failureReason?: string | null; recoveryReason?: string | null } = {},
  ): ReleaseDeploymentIntent | undefined {
    return this.store.updateReleaseIntentStatus(intentKey, status, patch);
  }

  acquireLease(intentKey: string, workerId: string, durationMs = DEFAULT_LEASE_MS): AcquireResult {
    return this.store.acquireReleaseIntentLease(intentKey, workerId, durationMs);
  }

  renewLease(intentKey: string, workerId: string, durationMs = DEFAULT_LEASE_MS): boolean {
    return this.store.renewReleaseIntentLease(intentKey, workerId, durationMs);
  }

  releaseLease(intentKey: string, workerId: string): boolean {
    return this.store.releaseReleaseIntentLease(intentKey, workerId);
  }

  listRecoverable(): ReleaseDeploymentIntent[] {
    return this.store.listRecoverableReleaseIntents();
  }
}
