// src/core/container-registry-provider.ts
// Phase 106: concrete production container registry adapter.
//
// Implements the existing ContainerRegistryProvider contract. Every operation
// uses the existing DockerAdapter (allowlisted structured ops only; no shell
// strings) and the existing credential boundary (env-based config). The
// registry-side immutable digest is obtained authoritatively via a post-push
// `docker inspect` reading RepoDigests — never derived from tags, timestamps,
// or artifact content.

import type { ContainerRegistryProvider, ImageReference } from "./types";
import type { DockerAdapter } from "./runtime";
import { readRegistryConfig, describeRegistryConfig } from "./container-registry-config";

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export interface RegistryPublication {
  ok: boolean;
  reason: string | null;
  digest: string | null;
  immutable_reference: string | null;
}

/**
 * Extract the authoritative registry digest from a `docker inspect` payload
 * by reading RepoDigests. Prefers an entry containing "@sha256:". Returns null
 * when no valid digest is present (never invents one).
 */
function extractRepoDigest(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    const doc = Array.isArray(parsed) ? parsed[0] : parsed;
    const digests: string[] = Array.isArray((doc as { RepoDigests?: unknown })?.RepoDigests)
      ? ((doc as { RepoDigests: unknown[] }).RepoDigests.filter((x) => typeof x === "string") as string[])
      : [];
    const first = digests.find((d) => d.includes("@sha256:")) ?? "";
    const at = first.indexOf("@");
    const d = at > 0 ? first.slice(at + 1).toLowerCase() : "";
    return SHA256_RE.test(d) ? d : null;
  } catch {
    return null;
  }
}

export class DockerRegistryProvider implements ContainerRegistryProvider {
  readonly name = "docker-registry";

  constructor(
    private readonly docker: DockerAdapter,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Perform a real network check against the configured registry's /v2/
   * endpoint using the configured credentials. This proves API-level
   * reachability and credential acceptance without mutating any state.
   *
   * Note: this check does NOT prove that the local Docker daemon holds the
   * same credentials. If the daemon is not logged in, `push()` will surface
   * the real Docker error rather than silently claiming success.
   */
  async authenticate(): Promise<{ ok: boolean; reason: string | null }> {
    const cfg = readRegistryConfig();
    if (!cfg.ok) return { ok: false, reason: cfg.reason };

    const url = "https://" + cfg.config.host + "/v2/";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.config.username) {
      const basic = Buffer.from(cfg.config.username + ":" + cfg.config.token).toString("base64");
      headers["Authorization"] = "Basic " + basic;
    } else {
      headers["Authorization"] = "Bearer " + cfg.config.token;
    }

    try {
      const res = await this.fetchImpl(url, { method: "GET", headers });
      // 200 = reachable + authenticated; 401 = reachable but token invalid.
      if (res.status === 200) return { ok: true, reason: null };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: "BLOCKED: registry rejected the configured credentials (HTTP " + res.status + ")" };
      }
      return { ok: false, reason: "BLOCKED: registry returned HTTP " + res.status + " for /v2/" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Never echo the token even if the fetch implementation includes it.
      const safe = msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
                      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
      return { ok: false, reason: "BLOCKED: registry unreachable — " + safe };
    }
  }

  /**
   * Push a locally-tagged image to the registry.
   *
   * The `ref.full` must be a fully-qualified `<host>/<repository>:<tag>`.
   * ':latest' is rejected. No flags are accepted; the adapter validates the
   * ref and passes exactly one argument to `docker push`.
   */
  async push(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }> {
    if (!ref.repository) return { ok: false, reason: "BLOCKED: repository is required" };
    if (!ref.tag) return { ok: false, reason: "BLOCKED: tag is required" };
    if (ref.tag === "latest") return { ok: false, reason: "BLOCKED: refusing to push mutable ':latest' tag" };
    if (/[@\s]/.test(ref.full)) return { ok: false, reason: "BLOCKED: ref contains forbidden characters" };
    if (ref.full.startsWith("-")) return { ok: false, reason: "BLOCKED: ref must not begin with '-'" };

    const cfg = readRegistryConfig();
    if (!cfg.ok) return { ok: false, reason: cfg.reason };

    const r = await this.docker.run({ kind: "push", ref: ref.full });
    if (r.status === "BLOCKED") {
      return { ok: false, reason: r.blocked_reason ?? "docker push blocked" };
    }
    if (r.status !== "SUCCEEDED" || r.exit_code !== 0) {
      const stderr = (r.stderr || "").slice(0, 300);
      return { ok: false, reason: "push failed (exit " + r.exit_code + "): " + stderr };
    }
    return { ok: true, reason: null };
  }

  /**
   * Post-push resolution of the authoritative registry digest.
   *
   * Runs `docker inspect <ref.full>` against the same daemon that performed
   * the push. Reads RepoDigests[0] (or the first entry containing "@sha256:")
   * and validates the format. A malformed or absent digest yields
   * ok:false / digest:null — no fabricated digest is ever returned.
   */
  async resolvePublishedDigest(ref: ImageReference): Promise<RegistryPublication> {
    const r = await this.docker.run({ kind: "inspect", image: ref.full });
    if (r.status !== "SUCCEEDED" || r.exit_code !== 0) {
      return {
        ok: false,
        digest: null,
        immutable_reference: null,
        reason: "BLOCKED: post-push inspect failed: " + (r.blocked_reason ?? (r.stderr || "").slice(0, 200)),
      };
    }
    const digest = extractRepoDigest(r.stdout);
    if (!digest) {
      return {
        ok: false,
        digest: null,
        immutable_reference: null,
        reason: "BLOCKED: registry returned no authoritative sha256 digest",
      };
    }
    return {
      ok: true,
      digest,
      immutable_reference: ref.repository + "@" + digest,
      reason: null,
    };
  }

  /** Registry pull — not implemented this pass; BLOCKED honestly. */
  async pull(_ref: ImageReference): Promise<{ ok: boolean; reason: string | null }> {
    return { ok: false, reason: "BLOCKED: pull is not implemented in Phase 106" };
  }

  /**
   * Registry inspect — same as `docker inspect` on the local daemon for the
   * pushed ref. If the local daemon no longer holds the image, the caller
   * must fall back to `resolvePublishedDigest` semantics. BLOCKED when the
   * image is not present.
   */
  async inspect(ref: ImageReference): Promise<{ ok: boolean; reason: string | null }> {
    const r = await this.docker.run({ kind: "inspect", image: ref.full });
    if (r.status !== "SUCCEEDED" || r.exit_code !== 0) {
      return { ok: false, reason: r.blocked_reason ?? "docker inspect failed" };
    }
    if (!extractRepoDigest(r.stdout)) {
      return { ok: false, reason: "BLOCKED: no authoritative sha256 digest for ref" };
    }
    return { ok: true, reason: null };
  }

  /** Registry delete — not implemented this pass; BLOCKED honestly. */
  async delete(_ref: ImageReference): Promise<{ ok: boolean; reason: string | null }> {
    return { ok: false, reason: "BLOCKED: delete is not implemented in Phase 106" };
  }

  /** Non-secret diagnostic summary for audit/evidence use. */
  describe(): { host: string | null; username: string | null; configured: boolean } {
    return describeRegistryConfig();
  }
}

export { extractRepoDigest };