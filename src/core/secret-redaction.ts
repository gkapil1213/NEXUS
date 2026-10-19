// src/core/secret-redaction.ts

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
  'connectionstring',
  'databaseurl',
  'dburl',
  'cookie',
  'session',
  'bearer',
]);

/**
 * Patterns applied to string values. Each match is replaced with
 * [REDACTED:<label>] so operators can see the shape of what was scrubbed
 * without seeing the value.
 *
 * Phase 272: added coverage for GitHub tokens, provider API keys, AWS
 * access keys, PEM private key blocks, and embedded key=value credentials.
 * The URL-authority pattern already existed from Phase 271 and is
 * applied first (before these) to preserve scheme+host while redacting
 * userinfo.
 */
const STRING_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED:github_token]"],
  [/gho_[A-Za-z0-9]{20,}/g, "[REDACTED:github_oauth_token]"],
  [/sk-[A-Za-z0-9]{16,}/g, "[REDACTED:provider_api_key]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private_key]"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "[REDACTED:embedded_credential]"],
];

/**
 * Recursively redact sensitive values in an object/array/string.
 * Sensitive keys are matched case-insensitively and partial matches (e.g., contains 'token') are redacted.
 * Values are replaced with '[REDACTED]'.
 */
export function redactSecrets<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    let s = input as unknown as string;
    // Phase 271: URL authority redaction (preserve scheme+host, redact userinfo)
    s = s.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
      '$1[REDACTED]@'
    );
    // Phase 272: other secret-shaped string values
    for (const [re, label] of STRING_SECRET_PATTERNS) {
      re.lastIndex = 0;
      s = s.replace(re, label);
    }
    return s as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item)) as unknown as T;
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = Array.from(SENSITIVE_KEYS).some(
        (sk) => lowerKey === sk || lowerKey.includes(sk)
      );
      if (isSensitive) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSecrets(value);
      }
    }
    return result as unknown as T;
  }

  return input;
}