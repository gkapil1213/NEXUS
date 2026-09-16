// src/core/ci-artifact-contract.ts
//
// Phase 132: strict machine-readable contract for the artifact that a real
// GitHub Actions workflow publishes to bind a remote CI build to a NEXUS
// execution. PURE module: no network, no filesystem, no secrets.

import zlib from "node:zlib";

export const NEXUS_IMAGE_DIGEST_ARTIFACT_NAME = "nexus-image-digest.json";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXECUTION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT_SHA_RE = /^[a-f0-9]{7,64}$/;
const IMAGE_REPO_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NexusImageDigestArtifact {
  schema_version: 1;
  execution_id: string;
  project_id?: string | null;
  repository: string;
  commit_sha: string;
  ci_provider: "github-actions";
  external_run_id: string;
  image_repository: string;
  image_tag: string;
  image_digest: string;
  immutable_reference: string;
  published_at?: string;
  build_workflow?: string;
}

export interface CiArtifactValidationContext {
  executionId: string;
  projectId?: string | null;
  repository: string;
  commitSha: string;
  externalRunId: string;
  providerId: "github-actions";
}

export type CiArtifactValidationResult =
  | { ok: true; artifact: NexusImageDigestArtifact }
  | { ok: false; reason: string };

export function validateCiArtifact(
  rawJson: string,
  ctx: CiArtifactValidationContext,
): CiArtifactValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: "MALFORMED_JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "NOT_AN_OBJECT" };
  }
  const a = parsed as Record<string, unknown>;

  if (a.schema_version !== 1) return { ok: false, reason: "SCHEMA_VERSION_UNSUPPORTED" };

  const str = (k: string): string | null =>
    typeof a[k] === "string" && (a[k] as string).length > 0 ? (a[k] as string) : null;

  const execution_id = str("execution_id");
  if (!execution_id) return { ok: false, reason: "MISSING_EXECUTION_ID" };
  if (!EXECUTION_ID_RE.test(execution_id)) return { ok: false, reason: "MALFORMED_EXECUTION_ID" };
  if (execution_id !== ctx.executionId) return { ok: false, reason: "EXECUTION_ID_MISMATCH" };

  const repository = str("repository");
  if (!repository) return { ok: false, reason: "MISSING_REPOSITORY" };
  if (!OWNER_REPO_RE.test(repository)) return { ok: false, reason: "MALFORMED_REPOSITORY" };
  if (repository !== ctx.repository) return { ok: false, reason: "REPOSITORY_MISMATCH" };

  const commit_sha = str("commit_sha");
  if (!commit_sha) return { ok: false, reason: "MISSING_COMMIT_SHA" };
  if (!COMMIT_SHA_RE.test(commit_sha)) return { ok: false, reason: "MALFORMED_COMMIT_SHA" };
  if (commit_sha !== ctx.commitSha) return { ok: false, reason: "COMMIT_SHA_MISMATCH" };

  const external_run_id = str("external_run_id");
  if (!external_run_id) return { ok: false, reason: "MISSING_EXTERNAL_RUN_ID" };
  if (external_run_id !== ctx.externalRunId) return { ok: false, reason: "EXTERNAL_RUN_ID_MISMATCH" };

  const ci_provider = str("ci_provider");
  if (ci_provider !== ctx.providerId) return { ok: false, reason: "CI_PROVIDER_MISMATCH" };

  const image_repository = str("image_repository");
  if (!image_repository) return { ok: false, reason: "MISSING_IMAGE_REPOSITORY" };
  if (!IMAGE_REPO_RE.test(image_repository)) return { ok: false, reason: "MALFORMED_IMAGE_REPOSITORY" };

  const image_tag = str("image_tag");
  if (!image_tag) return { ok: false, reason: "MISSING_IMAGE_TAG" };
  if (image_tag === "latest") return { ok: false, reason: "MUTABLE_TAG_FORBIDDEN" };
  if (!TAG_RE.test(image_tag)) return { ok: false, reason: "MALFORMED_IMAGE_TAG" };

  const image_digest = str("image_digest");
  if (!image_digest) return { ok: false, reason: "MISSING_IMAGE_DIGEST" };
  if (!SHA256_RE.test(image_digest)) return { ok: false, reason: "MALFORMED_IMAGE_DIGEST" };

  const immutable_reference = str("immutable_reference");
  if (!immutable_reference) return { ok: false, reason: "MISSING_IMMUTABLE_REFERENCE" };
  const expectedRef = image_repository + "@" + image_digest;
  if (immutable_reference !== expectedRef) return { ok: false, reason: "IMMUTABLE_REFERENCE_MISMATCH" };

  if ("project_id" in a && a.project_id !== null && typeof a.project_id !== "string") {
    return { ok: false, reason: "MALFORMED_PROJECT_ID" };
  }
  if (ctx.projectId && typeof a.project_id === "string" && a.project_id !== ctx.projectId) {
    return { ok: false, reason: "PROJECT_ID_MISMATCH" };
  }

  return {
    ok: true,
    artifact: {
      schema_version: 1,
      execution_id,
      project_id: typeof a.project_id === "string" ? a.project_id : null,
      repository,
      commit_sha,
      ci_provider: "github-actions",
      external_run_id,
      image_repository,
      image_tag,
      image_digest,
      immutable_reference,
      published_at: typeof a.published_at === "string" ? a.published_at : undefined,
      build_workflow: typeof a.build_workflow === "string" ? a.build_workflow : undefined,
    },
  };
}

/* -------------------- Safe single-member ZIP extraction -------------------- */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_EOCD_SCAN = 22 + 65535;

export function extractSingleZipMember(
  zip: Buffer,
  expectedName: string,
  maxUncompressedBytes = 5 * 1024 * 1024,
): Buffer {
  if (zip.length < 22) throw new Error("ZIP_TOO_SMALL");

  let eocdOff = -1;
  const scanStart = Math.max(0, zip.length - MAX_EOCD_SCAN);
  for (let i = zip.length - 22; i >= scanStart; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("ZIP_EOCD_NOT_FOUND");

  const cdCount = zip.readUInt16LE(eocdOff + 10);
  const cdOff = zip.readUInt32LE(eocdOff + 16);
  if (cdCount !== 1) throw new Error("ZIP_UNEXPECTED_MEMBER_COUNT");
  if (cdOff <= 0 || cdOff + 46 > zip.length) throw new Error("ZIP_TRUNCATED");

  if (zip.readUInt32LE(cdOff) !== CD_SIG) throw new Error("ZIP_BAD_CENTRAL_DIRECTORY");
  const method = zip.readUInt16LE(cdOff + 10);
  const compSize = zip.readUInt32LE(cdOff + 20);
  const uncompSize = zip.readUInt32LE(cdOff + 24);
  const nameLen = zip.readUInt16LE(cdOff + 28);
  const localOff = zip.readUInt32LE(cdOff + 42);

  if (nameLen === 0 || cdOff + 46 + nameLen > zip.length) throw new Error("ZIP_BAD_NAME");
  const name = zip.subarray(cdOff + 46, cdOff + 46 + nameLen).toString("utf8");
  if (name !== expectedName) throw new Error("ZIP_WRONG_MEMBER");
  if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
    throw new Error("ZIP_UNSAFE_NAME");
  }
  if (uncompSize > maxUncompressedBytes) throw new Error("ZIP_UNCOMPRESSED_TOO_LARGE");

  if (localOff + 30 > zip.length) throw new Error("ZIP_BAD_LOCAL_HEADER");
  if (zip.readUInt32LE(localOff) !== LFH_SIG) throw new Error("ZIP_BAD_LOCAL_HEADER");
  const lfhNameLen = zip.readUInt16LE(localOff + 26);
  const lfhExtraLen = zip.readUInt16LE(localOff + 28);
  const dataOff = localOff + 30 + lfhNameLen + lfhExtraLen;
  if (dataOff + compSize > zip.length) throw new Error("ZIP_TRUNCATED_DATA");

  const data = zip.subarray(dataOff, dataOff + compSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: maxUncompressedBytes });
  }
  throw new Error("ZIP_UNSUPPORTED_COMPRESSION");
}