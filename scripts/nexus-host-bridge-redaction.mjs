// scripts/nexus-host-bridge-redaction.mjs
//
// Shared production redactor used by nexus-host-bridge.mjs for captured
// stdout and stderr. Phase 278 tests import this same implementation
// directly to validate redaction without spawning the bridge process.
//
// Covers provider and GitHub tokens, AWS access keys, Bearer credentials,
// private keys, embedded credentials, and URL userinfo. Marker formats are
// intentionally stable because callers and audit tests inspect the labels.

const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github token]"],
  [/gho_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github oauth token]"],
  [/gh[usr]_[A-Za-z0-9_-]{20,}/g, "[REDACTED:github token]"],
  [/sk-[A-Za-z0-9][A-Za-z0-9-]{15,}/g, "[REDACTED:provider api key]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/gi, "[REDACTED:bearer_token]"],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED:aws access key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private key]"],
  [/(?<![A-Za-z0-9_])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|token|password|passwd|pwd|secret)(?![A-Za-z0-9_]|_(?:at|ms|count|level|type|status|name|length|bytes|duration|index|size))\s*[:=]\s*(?:["']([^"']{1,})["']|(?!\[REDACTED:)([^\s"',;)\]}>]*[^\s"',;.)\]}>]))/gi, "[REDACTED:embedded credential]"],
];

export function redact(text) {
  let out = String(text).replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
    "$1[REDACTED]@",
  );
  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, label);
  }
  return out;
}
