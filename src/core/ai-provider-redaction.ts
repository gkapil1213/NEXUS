// src/core/ai-provider-redaction.ts
// Phase 216: reusable secret redaction. Extends the pattern already used by
// release-recovery-supervisor.ts so all AI provider traffic passes through
// one canonical redactor before it can reach an event, artifact, log line,
// or error message.

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{10,}/gi;
const KEY_VALUE = /\b(access_token|refresh_token|id_token|token|password|passwd|pwd|api[_-]?key|apikey|secret|client_secret|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;

// Phase 276: the ai-provider path previously covered only Bearer / Basic /
// key=value / PEM. It silently passed AWS access key IDs, GitHub personal
// access tokens, provider `sk-` keys, and URL-embedded credentials through to
// logs and error messages. These four patterns close that gap. They are
// duplicated here (rather than imported from secret-redaction.ts) to keep this
// module's marker convention — `Bearer [REDACTED]`, `Basic [REDACTED]` — stable
// for any consumer that string-matches on it.
const URL_CRED     = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const AWS_KEY      = /(?:AKIA|ASIA)[0-9A-Z]{16}/g;
const GITHUB_TOKEN = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{20,}/g;
const PROVIDER_KEY = /\bsk-[A-Za-z0-9][A-Za-z0-9-]{15,}/g;

export function redactSecrets(input: string): string {
  if (!input) return input;
  let s = input;
  // Phase 276: URL credentials first, so a following pattern cannot consume
  // only part of the userinfo and leave the rest visible.
  s = s.replace(URL_CRED,     "$1[REDACTED]@");
  s = s.replace(AWS_KEY,      "[REDACTED:aws_access_key]");
  s = s.replace(GITHUB_TOKEN, "[REDACTED:github_token]");
  s = s.replace(PROVIDER_KEY, "[REDACTED:provider_api_key]");
  // Phase 216 patterns — unchanged.
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
