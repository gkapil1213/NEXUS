// src/core/ai-provider-redaction.ts
// Phase 216: reusable secret redaction. Extends the pattern already used by
// release-recovery-supervisor.ts so all AI provider traffic passes through
// one canonical redactor before it can reach an event, artifact, log line,
// or error message.

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{10,}/gi;
const KEY_VALUE = /\b(access_token|refresh_token|id_token|token|password|passwd|pwd|api[_-]?key|apikey|secret|client_secret|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;

export function redactSecrets(input: string): string {
  if (!input) return input;
  let s = input;
  s = s.replace(BEARER, "Bearer [REDACTED]");
  s = s.replace(BASIC, "Basic [REDACTED]");
  s = s.replace(KEY_VALUE, (_m, k) => k + ": [REDACTED]");
  s = s.replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  return s;
}

export function redactDeep(value: unknown, maxDepth = 6, depth = 0): unknown {
  if (depth > maxDepth) return "[DEPTH LIMIT]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, maxDepth, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|apikey|api_key|authorization|bearer|credential/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v, maxDepth, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function bounded(value: string, maxBytes: number): string {
  if (!value) return value;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const slice = value.slice(0, maxBytes);
  return Buffer.byteLength(slice, "utf8") <= maxBytes ? slice : value.slice(0, Math.floor(maxBytes / 2));
}
