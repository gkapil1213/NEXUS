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
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'session_token',
  'session_id',
  'client_secret',
  'client_id_secret',
  'access_key',
  'secret_key',
  'signing_key',
  'encryption_key',
]);

const STRING_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github_token]"],
  [/gho_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github_oauth_token]"],
  [/sk-[A-Za-z0-9]{16,}/g, "[REDACTED:provider_api_key]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private_key]"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}["']?/gi, "[REDACTED:embedded_credential]"],
];

/**
 * Phase 273: cycle-safe entry point.
 *
 * The internal implementation tracks visited objects via a WeakSet so that
 * self-referencing or mutually-referencing payloads cannot overflow the
 * call stack. A visited object is replaced with "[REDACTED:cycle]" so that
 * consumers can see the shape without following the loop.
 */
export function redactSecrets<T>(input: T): T {
  return redactSecretsImpl(input, new WeakSet<object>());
}

function redactSecretsImpl<T>(input: T, seen: WeakSet<object>): T {
  if (input === null || input === undefined) {
    return input;
  }

  // Phase 273: Error instances do not expose `message`/`stack` via
  // Object.entries (they live on the prototype). Serialize them explicitly
  // so the diagnostic is preserved in a redacted form instead of being
  // silently dropped.
  if (input instanceof Error) {
    const out: Record<string, unknown> = {
      name: input.name,
      message: redactSecretsImpl(input.message, seen),
    };
    if (input.stack) {
      out.stack = redactSecretsImpl(input.stack, seen);
    }
    return out as unknown as T;
  }

  if (typeof input === 'string') {
    let s = input as unknown as string;
    s = s.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
      '$1[REDACTED]@'
    );
    for (const [re, label] of STRING_SECRET_PATTERNS) {
      re.lastIndex = 0;
      s = s.replace(re, label);
    }
    return s as unknown as T;
  }

  if (Array.isArray(input)) {
    if (seen.has(input as unknown as object)) {
      return '[REDACTED:cycle]' as unknown as T;
    }
    seen.add(input as unknown as object);
    return input.map((item) => redactSecretsImpl(item, seen)) as unknown as T;
  }

  if (typeof input === 'object') {
    if (seen.has(input as object)) {
      return '[REDACTED:cycle]' as unknown as T;
    }
    seen.add(input as object);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isSensitive = Array.from(SENSITIVE_KEYS).some((sk) => {
        const normalizedSecretKey = sk.toLowerCase().replace(/[^a-z0-9]/g, '');
        return normalizedKey === normalizedSecretKey ||
          normalizedKey === `${normalizedSecretKey}s`;
      });
      if (isSensitive) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSecretsImpl(value, seen);
      }
    }
    return result as unknown as T;
  }

  return input;
}