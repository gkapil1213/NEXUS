// src/core/ci-artifact-reconciliation.service.ts
//
// Phase 132: consume the authoritative GitHub Actions artifact, validate it
// strictly, and durably register an IMAGE_DIGEST bound to the exact
// execution/commit/CI run. Idempotent by (execution_id, run_id, image_digest).
//
// The remote CI digest comes only from the artifact produced by the GitHub
// Actions workflow — never from the local container runtime.

import type { ArtifactService } from "./services";
import type { GitHubActionsCICDProvider } from "./github-actions-cicd-provider";
import {
  NEXUS_IMAGE_DIGEST_ARTIFACT_NAME,
  validateCiArtifact,
  extractSingleZipMember,
  type NexusImageDigestArtifact,
} from "./ci-artifact-contract";

export interface SqliteStatement {
  get(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  run(...a: unknown[]): unknown;
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
}

export interface ReconcileInput {
  runId: string;
  executionId: string;
  projectId: string | null;
  providerId: "github-actions";
  externalRunId: string;
  repository: string;
  commitSha: string;
}

export type ReconcileOutcome =
  | {
      state: "REGISTERED";
      artifact: NexusImageDigestArtifact;
      nexusArtifactId: string;
      bindingId: string;
      githubArtifactId: string;
    }
  | { state: "BLOCKED"; reason: string; githubArtifactId?: string };

export interface CiImageDigestBinding {
  binding_id: string;
  execution_id: string;
  project_id: string | null;
  run_id: string;
  provider_id: string;
  external_run_id: string;
  repository: string;
  commit_sha: string;
  image_repository: string;
  image_tag: string;
  image_digest: string;
  immutable_reference: string;
  nexus_artifact_id: string;
  created_at: number;
}

const MAX_COMPRESSED_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_ARTIFACT_BYTES = 5 * 1024 * 1024;

function redact(s: string): string {
  return s
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [REDACTED]");
}

export class CiArtifactReconciliationService {
  constructor(
    private readonly db: SqliteDb,
    private readonly artifacts: ArtifactService,
    private readonly githubProvider: GitHubActionsCICDProvider,
  ) {}

  findBinding(executionId: string, runId: string, imageDigest: string): CiImageDigestBinding | undefined {
    const row = this.db.prepare(
      "SELECT * FROM ci_image_digest_bindings WHERE execution_id = ? AND run_id = ? AND image_digest = ?"
    ).get(executionId, runId, imageDigest) as CiImageDigestBinding | undefined;
    return row;
  }

  findBindingForExecutionDigest(executionId: string, imageDigest: string): CiImageDigestBinding | undefined {
    return this.db.prepare(
      "SELECT * FROM ci_image_digest_bindings WHERE execution_id = ? AND image_digest = ?"
    ).get(executionId, imageDigest) as CiImageDigestBinding | undefined;
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
    const parts = input.repository.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) return { state: "BLOCKED", reason: "INVALID_REPOSITORY" };

    let listed: Awaited<ReturnType<GitHubActionsCICDProvider["listArtifacts"]>>;
    try {
      listed = await this.githubProvider.listArtifacts(input.externalRunId, { owner, repo });
    } catch (e) {
      return { state: "BLOCKED", reason: "ARTIFACT_LIST_FAILED:" + redact(String((e as Error).message ?? e)).slice(0, 200) };
    }

    const candidates = listed.filter((a) => a.name === NEXUS_IMAGE_DIGEST_ARTIFACT_NAME);
    if (candidates.length === 0) return { state: "BLOCKED", reason: "ARTIFACT_MISSING" };
    if (candidates.length > 1) return { state: "BLOCKED", reason: "ARTIFACT_AMBIGUOUS" };
    const chosen = candidates[0];
    if (chosen.expired) return { state: "BLOCKED", reason: "ARTIFACT_EXPIRED", githubArtifactId: String(chosen.id) };

    let bytes: Buffer;
    try {
      bytes = await this.githubProvider.downloadArtifact(
        input.externalRunId,
        chosen.id,
        { owner, repo },
        MAX_COMPRESSED_ARTIFACT_BYTES,
      );
    } catch (e) {
      return { state: "BLOCKED", reason: "ARTIFACT_DOWNLOAD_FAILED:" + redact(String((e as Error).message ?? e)).slice(0, 200), githubArtifactId: String(chosen.id) };
    }

    let rawJson: string;
    try {
      const inner = extractSingleZipMember(bytes, NEXUS_IMAGE_DIGEST_ARTIFACT_NAME, MAX_UNCOMPRESSED_ARTIFACT_BYTES);
      rawJson = inner.toString("utf8");
    } catch (e) {
      return { state: "BLOCKED", reason: "ARTIFACT_ARCHIVE_REJECTED:" + String((e as Error).message ?? e).slice(0, 120), githubArtifactId: String(chosen.id) };
    }

    const validated = validateCiArtifact(rawJson, {
      executionId: input.executionId,
      projectId: input.projectId,
      repository: input.repository,
      commitSha: input.commitSha,
      externalRunId: input.externalRunId,
      providerId: input.providerId,
    });
    if (!validated.ok) {
      return { state: "BLOCKED", reason: "ARTIFACT_VALIDATION_FAILED:" + validated.reason, githubArtifactId: String(chosen.id) };
    }
    const a = validated.artifact;

    const existing = this.findBinding(input.executionId, input.runId, a.image_digest);
    if (existing) {
      return {
        state: "REGISTERED",
        artifact: a,
        nexusArtifactId: existing.nexus_artifact_id,
        bindingId: existing.binding_id,
        githubArtifactId: String(chosen.id),
      };
    }

    const conflicting = this.db.prepare(
      "SELECT * FROM ci_image_digest_bindings WHERE execution_id = ? AND run_id = ?"
    ).all(input.executionId, input.runId) as CiImageDigestBinding[];
    if (conflicting.length > 0) {
      return { state: "BLOCKED", reason: "DIGEST_CONFLICT_WITH_EXISTING_BINDING", githubArtifactId: String(chosen.id) };
    }

    const content = JSON.stringify(a);
    let ref: Awaited<ReturnType<ArtifactService["register"]>>;
    try {
      ref = await this.artifacts.register(input.executionId, {
        kind: "IMAGE_DIGEST",
        name: NEXUS_IMAGE_DIGEST_ARTIFACT_NAME,
        content,
      });
    } catch (e) {
      return { state: "BLOCKED", reason: "ARTIFACT_REGISTER_FAILED:" + String((e as Error).message ?? e).slice(0, 200), githubArtifactId: String(chosen.id) };
    }

    const bindingId = "cidb_" + input.runId + "_" + a.image_digest.slice(7, 23);
    const now = Date.now();
    try {
      this.db.prepare(
        "INSERT INTO ci_image_digest_bindings (" +
        "binding_id, execution_id, project_id, run_id, provider_id, " +
        "external_run_id, repository, commit_sha, image_repository, " +
        "image_tag, image_digest, immutable_reference, nexus_artifact_id, created_at" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        bindingId, input.executionId, input.projectId, input.runId, input.providerId,
        input.externalRunId, input.repository, input.commitSha, a.image_repository,
        a.image_tag, a.image_digest, a.immutable_reference, ref.id, now,
      );
    } catch (e) {
      const race = this.findBinding(input.executionId, input.runId, a.image_digest);
      if (!race) {
        return { state: "BLOCKED", reason: "BINDING_WRITE_FAILED:" + String((e as Error).message ?? e).slice(0, 200), githubArtifactId: String(chosen.id) };
      }
      return { state: "REGISTERED", artifact: a, nexusArtifactId: race.nexus_artifact_id, bindingId: race.binding_id, githubArtifactId: String(chosen.id) };
    }

    return {
      state: "REGISTERED",
      artifact: a,
      nexusArtifactId: ref.id,
      bindingId,
      githubArtifactId: String(chosen.id),
    };
  }
}