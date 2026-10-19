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
 * Recursively redact sensitive values in an object/array/string.
 * Sensitive keys are matched case-insensitively and partial matches (e.g., contains 'token') are redacted.
 * Values are replaced with '[REDACTED]'.
 */
export function redactSecrets<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return input.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
      '$1[REDACTED]@'
    ) as T;
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