/**
 * NEXUS Phase 1 - immutable audit trail.
 *
 * Records authentication, authorization decisions, resource changes and
 * security-sensitive operations. Metadata is secret-redacted BEFORE storage;
 * passwords, tokens, API keys and secret values never reach the ledger.
 * Records are append-only: no update or delete path exists.
 */

import { nid, type NexusEngine } from "./db";
import type { AuditRecord, AuditResult } from "./types";
import { makeSensitiveKeyClassifier, redactTextWith, SECRET_TEXT_PATTERNS } from "./secret-redaction";

/**
 * Phase 283: shared classifier from secret-redaction.ts, extended with `salt`
 * because salts must never reach the audit ledger. The base policy
 * (SENSITIVE_KEYS + SAFE_SUFFIXES exemption) is owned by the shared redactor
 * so the two redactors cannot drift on key coverage
 * (Phase 282 SECURITY_POLICY.md:41-46).
 */
const isSensitiveKey = makeSensitiveKeyClassifier(["salt"]);

/**
 * Phase 283: the driver and URL-userinfo scrub are shared with the general
 * redactor; only the marker set is audit-specific. Audit markers use spaces
 * (`[REDACTED:github token]`), locked by test-phase278. The shared redactor
 * uses underscores (`[REDACTED:github_token]`), locked by test-phase277/273.
 * Both formats are consumer-visible; do not unify.
 */
const AUDIT_MARKERS: Readonly<Record<string, string>> = {
  "[REDACTED:github_token]": "[REDACTED:github token]",
  "[REDACTED:github_oauth_token]": "[REDACTED:github oauth token]",
  "[REDACTED:provider_api_key]": "[REDACTED:provider api key]",
  "[REDACTED:bearer_token]": "[REDACTED:bearer token]",
  "[REDACTED:aws_access_key]": "[REDACTED:aws access key]",
  "[REDACTED:private_key]": "[REDACTED:private key]",
  "[REDACTED:embedded_credential]": "[REDACTED:embedded credential]",
};

const AUDIT_TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> =
  SECRET_TEXT_PATTERNS.map(([pattern, marker]) =>
    [pattern, AUDIT_MARKERS[marker] ?? marker] as const
  );

/** Redact secret-looking material from arbitrary text. */
export function redactText(text: string): string {
  return redactTextWith(text, AUDIT_TEXT_PATTERNS);
}

/** Deep-clean a metadata object: forbidden keys removed, strings redacted. */
function safeAuditClassName(value: object): string {
  try {
    const proto = Object.getPrototypeOf(value);
    if (!proto) return "unknown";

    const ctor = Object.getOwnPropertyDescriptor(proto, "constructor");
    if (!ctor || !("value" in ctor) || typeof ctor.value !== "function") {
      return "unknown";
    }

    const name = Object.getOwnPropertyDescriptor(ctor.value, "name");
    if (name && "value" in name && typeof name.value === "string") {
      return name.value || "unknown";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}
function redactMetadataInternal(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return "[symbol]";
  if (typeof value === "function") return "[function]";

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      const desc = Object.getOwnPropertyDescriptor(value, String(index));
      if (!desc) continue;
      if (!desc.enumerable) continue;
      out[index] = "value" in desc
        ? redactMetadata(desc.value, depth + 1)
        : "[getter]";
    }
    return out;
  }

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof Map) {
    // Phase 282: string Map keys are subject to the same sensitive-key
    // policy as ordinary object keys. Sensitive entries are dropped.
    const entries: Array<[unknown, unknown]> = [];
    for (const [k, v] of value) {
      if (typeof k === "string" && isSensitiveKey(k)) continue;
      const keyNorm = typeof k === "string" ? redactText(k) : redactMetadata(k, depth + 1);
      entries.push([keyNorm, redactMetadata(v, depth + 1)]);
    }
    return { "$map": entries };
  }

  if (value instanceof Set) {
    const elements: unknown[] = [];
    for (const v of value) {
      elements.push(redactMetadata(v, depth + 1));
    }
    return { "$set": elements };
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;
    const out: Record<string, unknown> = {};
    // Phase 282: traverse via own-property descriptors so getters are never
    // invoked. Non-enumerable own properties are omitted, matching the
    // visibility of Object.entries.
    for (const k of Object.getOwnPropertyNames(value)) {
      if (isSensitiveKey(k)) continue;
      const desc = Object.getOwnPropertyDescriptor(value, k);
      if (!desc || !desc.enumerable) continue;
      if (!("value" in desc)) {
        out[k] = "[getter]";
        continue;
      }
      out[k] = redactMetadata(desc.value, depth + 1);
    }
    if (!isPlain) {
      const className = safeAuditClassName(value as object);
      return { "$class": className, ...out };
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

export function redactMetadata(value: unknown, depth = 0): unknown {
  try {
    return redactMetadataInternal(value, depth);
  } catch {
    return "[unavailable metadata]";
  }
}
