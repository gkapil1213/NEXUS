
import { redactSecrets as sharedRedact } from "./secret-redaction";

export function redactSecrets(text: string): string {
  if (!text) return text;

  const legacyPatterns = [
    /AWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi,
    /AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/gi,
    /AWS_SESSION_TOKEN\s*[:=]\s*\S+/gi,
    /COSIGN_PASSWORD\s*=\s*\S+/gi,
    /password\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /api[_-]?key\s*[:=]\s*\S+/gi,
    /github[_-]?token\s*[:=]\s*\S+/gi,
    /gitlab[_-]?token\s*[:=]\s*\S+/gi,
  ];

  // Protect legacy assignments before calling the shared redactor.
  // Authorization is intentionally excluded so the shared redactor
  // can handle Bearer credentials.
  let prefix = "__NEXUS_REDACTION_SLOT_";
  while (text.includes(prefix)) {
    prefix = `_${prefix}`;
  }

  const safeMarkers: string[] = [];
  let protectedText = text;

  for (const pattern of legacyPatterns) {
    protectedText = protectedText.replace(pattern, (match) => {
      const separatorIndex = match.search(/[:=]/);
      const key =
        separatorIndex >= 0
          ? match.slice(0, separatorIndex).trim()
          : "SECRET";

      const slot = `${prefix}${safeMarkers.length}__`;
      safeMarkers.push(`${key}=***REDACTED***`);
      return slot;
    });
  }

  let result = sharedRedact(protectedText);

  safeMarkers.forEach((marker, index) => {
    result = result.replace(`${prefix}${index}__`, marker);
  });

  return result;
}
