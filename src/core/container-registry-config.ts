// src/core/container-registry-config.ts
// Phase 106: registry configuration reader. Reads from environment variables
// using the NEXUS-established convention. No secrets are logged or returned
// in any error path; only presence/shape checks are reported.

export interface RegistryConfig {
  host: string;               // e.g. "ghcr.io" or "registry.example.com:5000"
  username: string | null;    // optional; some registries only need a token
  token: string;              // required
}

export type RegistryConfigResult =
  | { ok: true; config: RegistryConfig }
  | { ok: false; reason: string };

const HOST_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:[0-9]{1,5})?$/;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;

/**
 * Read the registry configuration from the process environment.
 *
 * Required:
 *   NEXUS_REGISTRY_HOST    — registry hostname (e.g. "ghcr.io")
 *   NEXUS_REGISTRY_TOKEN   — token / password
 * Optional:
 *   NEXUS_REGISTRY_USERNAME — username (Basic auth; if absent, Bearer is used)
 *
 * Missing or malformed configuration → { ok: false, reason: "BLOCKED: ..." }.
 */
export function readRegistryConfig(): RegistryConfigResult {
  const host = (process.env.NEXUS_REGISTRY_HOST ?? "").trim().toLowerCase();
  const token = process.env.NEXUS_REGISTRY_TOKEN ?? "";
  const username = (process.env.NEXUS_REGISTRY_USERNAME ?? "").trim() || null;

  if (!host) return { ok: false, reason: "BLOCKED: NEXUS_REGISTRY_HOST not configured" };
  if (!token) return { ok: false, reason: "BLOCKED: NEXUS_REGISTRY_TOKEN not configured" };
  if (!HOST_RE.test(host) && !LOCAL_HOST_RE.test(host)) {
    return { ok: false, reason: "BLOCKED: NEXUS_REGISTRY_HOST is malformed" };
  }
  return { ok: true, config: { host, username, token } };
}

/**
 * Return a redacted, non-secret summary of the current config for audit /
 * evidence use. Never includes the token.
 */
export function describeRegistryConfig(): { host: string | null; username: string | null; configured: boolean } {
  const host = (process.env.NEXUS_REGISTRY_HOST ?? "").trim().toLowerCase() || null;
  const username = (process.env.NEXUS_REGISTRY_USERNAME ?? "").trim() || null;
  const token = process.env.NEXUS_REGISTRY_TOKEN ?? "";
  return { host, username, configured: !!(host && token) };
}