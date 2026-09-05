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
    // If string looks like a secret (long random string, JWT, etc.) redact if its key was sensitive; but here we don't know key.
    // Since this function is called on entire objects, we only redact values when the key is sensitive.
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item)) as unknown as T;
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = Array.from(SENSITIVE_KEYS).some(
        (sk) => lowerKey === sk || lowerKey.includes(sk) || sk.includes(lowerKey)
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