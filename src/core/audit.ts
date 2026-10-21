/**
 * NEXUS Phase 1 — immutable audit trail.
 *
 * Records authentication, authorization decisions, resource changes and
 * security-sensitive operations. Metadata is secret-redacted BEFORE storage;
 * passwords, tokens, API keys and secret values never reach the ledger.
 * Records are append-only: no update or delete path exists.
 */

import { nid, type NexusEngine } from "./db";
import type { AuditRecord, AuditResult } from "./types";
import { SENSITIVE_KEYS, SAFE_SUFFIXES } from "./secret-redaction";

/**
 * Phase 276: keys whose values are dropped entirely before persistence.
 *
 * The previous implementation used an exact-match Set. That is what let
 * client_secret, refresh_token, access_token, session_id and aws_secret_key
 * survive `redactMetadata` even though the shared redactor (`secret-redaction`)
 * treats them as sensitive. This version uses the same normalize-and-substring
 * rule (plus the same SAFE_SUFFIXES exemption) as `secret-redaction.ts`, so
 * the two redactors can no longer drift apart on key coverage.
 *
 * `salt` is not in SENSITIVE_KEYS; it is retained as a NEXUS-specific
 * extra because salts must never reach the ledger.
 */
const NORMALIZED_SENSITIVE_KEYS: string[] = [
  ...Array.from(SENSITIVE_KEYS).map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "")),
  "salt",
];

const NORMALIZED_SAFE_SUFFIXES: string[] = SAFE_SUFFIXES.map(
  (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
);

function isSensitiveKey(rawKey: string): boolean {
  const normalized = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasSafeSuffix = NORMALIZED_SAFE_SUFFIXES.some((s) => normalized.endsWith(s));
  if (hasSafeSuffix) return false;
  return NORMALIZED_SENSITIVE_KEYS.some((k) => normalized.includes(k));
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/gi, "bearer token"],
  [/ghp_[A-Za-z0-9]{20,}/g, "github token"],
  [/gho_[A-Za-z0-9]{20,}/g, "github oauth token"],
  [/sk-[A-Za-z0-9]{16,}/g, "provider api key"],
  [/AKIA[0-9A-Z]{16}/g, "aws access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "embedded credential"],
];

/** Redact secret-looking material from arbitrary text. */
export function redactText(text: string): string {
  let out = text;
  // Phase 272: URL authority redaction (preserves scheme+host, redacts userinfo).
  // Applied first, matching secret-redaction.ts behavior, so URL structure is
  // preserved while the credential is scrubbed.
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
    '$1[REDACTED]@'
  );
  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

/** Deep-clean a metadata object: forbidden keys removed, strings redacted. */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactMetadata(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) continue;
      out[k] = redactMetadata(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class AuditService {
  private engine: NexusEngine;
  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  /** Append an audit record. Metadata is redacted before it is stored. */
  async record(input: {
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string;
    result: AuditResult;
    metadata?: Record<string, unknown>;
  }): Promise<AuditRecord> {
    const rec: AuditRecord = {
      id: nid("aud"),
      timestamp: Date.now(),
      actor: input.actor,
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      result: input.result,
      metadata: (redactMetadata(input.metadata ?? {}) as Record<string, unknown>) ?? {},
    };
    await this.engine.put("audit", rec.id, rec);
    return rec;
  }

  async list(limit = 200): Promise<AuditRecord[]> {
    const rows = await this.engine.all<AuditRecord>("audit");
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async byResource(resourceId: string): Promise<AuditRecord[]> {
    const rows = await this.engine.byIndex<AuditRecord>("audit", "byResource", resourceId);
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  }

  async count(): Promise<number> {
    return (await this.engine.all("audit")).length;
  }

  async probe(): Promise<boolean> {
    try {
      await this.count();
      return true;
    } catch {
      return false;
    }
  }
}
