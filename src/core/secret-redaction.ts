// src/core/secret-redaction.ts

export const SENSITIVE_KEYS = new Set([
  'password',
  'db_password',
  'aws_secret_key',
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
// Phase 273: keys ending with one of these suffixes are treated as
// non-secret metadata even when they contain a sensitive substring
// (e.g. session_started_at, authorization_level, token_count).
export const SAFE_SUFFIXES = [
  '_at', '_ms', '_count', '_level', '_type', '_status',
  '_name', '_length', '_bytes', '_duration', '_index', '_size',
];

/**
 * Phase 283: shared sensitive-key classifier.
 *
 * Normalizes the raw key (lowercase, strip non-alphanumeric), exempts it if it
 * ends with a SAFE_SUFFIXES entry, and substring-matches against SENSITIVE_KEYS
 * plus any caller-supplied extra keys. `audit.ts` extends this with `["salt"]`;
 * the shared redactor uses the base classifier unchanged.
 */
const NORMALIZED_SENSITIVE_KEYS: string[] = Array.from(SENSITIVE_KEYS).map(
  (k) => k.toLowerCase().replace(/[^a-z0-9]/g, ''),
);
const NORMALIZED_SAFE_SUFFIXES: string[] = SAFE_SUFFIXES.map(
  (s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''),
);

export function makeSensitiveKeyClassifier(
  extraKeys: readonly string[] = [],
): (rawKey: string) => boolean {
  const combined = [
    ...NORMALIZED_SENSITIVE_KEYS,
    ...extraKeys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')),
  ];
  return (rawKey: string): boolean => {
    const normalized = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (NORMALIZED_SAFE_SUFFIXES.some((s) => normalized.endsWith(s))) return false;
    return combined.some((k) => normalized.includes(k));
  };
}

export const isSensitiveKey: (rawKey: string) => boolean = makeSensitiveKeyClassifier();

export const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github_token]"],
  [/gho_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github_oauth_token]"],
  [/gh[usr]_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github_token]"],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9-]{15,}/g, "[REDACTED:provider_api_key]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/gi, "[REDACTED:bearer_token]"],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private_key]"],
  [/(?<![A-Za-z0-9_])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|token|password|passwd|pwd|secret)(?![A-Za-z0-9_]|_(?:at|ms|count|level|type|status|name|length|bytes|duration|index|size))\s*[:=]\s*(?:["']([^"']{1,})["']|(?!\[REDACTED:)([^\s"',;)\]}>]*[^\s"',;.)\]}>]))/gi, "[REDACTED:embedded_credential]"],
];

/**
 * Phase 283: shared text-redaction driver.
 *
 * Applies the URL-userinfo scrub (identical to audit's pre-283 behavior), then
 * every [RegExp, marker] pair the caller supplies. Marker strings are
 * caller-owned policy: audit uses spaces in its markers, this file uses
 * underscores. Both formats are consumer-visible and locked by their own
 * test suites; do not unify.
 */
export function redactTextWith(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string {
  let out = text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
    '$1[REDACTED]@',
  );
  for (const [re, label] of patterns) {
    re.lastIndex = 0;
    out = out.replace(re, label);
  }

  // Phase 285 G-3: an orphan closing bracket immediately following an
  // inserted redaction marker duplicates the marker's own `]`. Collapse
  // that duplicate only when the marker is not preceded by its own
  // opening bracket -- i.e. the input had a lone `]`, not a paired `[]`.
  out = out.replace(/(?<!\[)(\[REDACTED:[^\]\n]+\])\]/g, '$1');

  return out;
}

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

function readErrorField(
  error: Error,
  key: "name" | "message" | "stack"
): unknown {
  let current: object | null = error;

  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return "value" in descriptor ? descriptor.value : "[getter]";
    }
    current = Object.getPrototypeOf(current);
  }

  return undefined;
}

function redactSecretsImpl<T>(input: T, seen: WeakSet<object>): T {
  if (input === null || input === undefined) {
    return input;
  }

  // Phase 273: Error instances do not expose `message`/`stack` via
  // Object.entries (they live on the prototype). Serialize them explicitly
  // so the diagnostic is preserved in a redacted form instead of being
  // silently dropped.
  //
  // Phase 283: use descriptor-based field access so user-installed getters
  // on Error fields are never invoked. Natural V8 fields are non-enumerable
  // data properties on the prototype and are read correctly. A getter
  // descriptor (whether user-installed or otherwise) yields "[getter]".
  if (input instanceof Error) {
    const errorName = readErrorField(input, "name");
    const errorMessage = readErrorField(input, "message");
    const errorStack = readErrorField(input, "stack");

    const out: Record<string, unknown> = {
      name: redactSecretsImpl(errorName, seen),
      message: redactSecretsImpl(errorMessage, seen),
    };

    if (errorStack) {
      out.stack = redactSecretsImpl(errorStack, seen);
    }

    return out as unknown as T;
  }

  if (typeof input === 'string') {
    return redactTextWith(input as unknown as string, SECRET_TEXT_PATTERNS) as unknown as T;
  }

  if (Array.isArray(input)) {
    if (seen.has(input as unknown as object)) {
      return '[REDACTED:cycle]' as unknown as T;
    }
    seen.add(input as unknown as object);

    const result: unknown[] = new Array(input.length);
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor) continue;

      if (!("value" in descriptor)) {
        result[index] = "[getter]";
        continue;
      }

      result[index] = redactSecretsImpl(descriptor.value, seen);
    }
    return result as unknown as T;
  }

  if (typeof input === 'object') {
    if (seen.has(input as object)) {
      return '[REDACTED:cycle]' as unknown as T;
    }
    seen.add(input as object);

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const isSensitive = isSensitiveKey(key);

      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable) continue;

      if (isSensitive) {
        result[key] = '[REDACTED]';
      } else if (!("value" in descriptor)) {
        result[key] = "[getter]";
      } else {
        result[key] = redactSecretsImpl(descriptor.value, seen);
      }
    }
    return result as unknown as T;
  }

  return input;
}