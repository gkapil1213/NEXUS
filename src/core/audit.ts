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

/** Keys whose values are dropped entirely before persistence. */
const FORBIDDEN_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "private_key",
  "salt",
]);

const SECRET_PATTERNS: [RegExp, string][] = [
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
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
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
