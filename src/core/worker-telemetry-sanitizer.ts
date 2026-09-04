const SENSITIVE_KEYS = [
  "token", "password", "secret", "credential", "authorization",
  "privatekey", "private_key", "apikey", "api_key", "accesskey", "access_key",
  "refresh_token", "session_secret", "enrollment_token", "auth_header"
];

export function sanitizeTelemetryPayload(payload: any): any {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(sanitizeTelemetryPayload);
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sk) => lower.includes(sk))) {
      result[key] = "***REDACTED***";
    } else {
      result[key] = sanitizeTelemetryPayload(value);
    }
  }
  return result;
}
