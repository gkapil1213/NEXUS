// Phase 279: widened to full credential-class coverage. Delegates to the
// canonical shared redactor for the 7 classes Phase 276-278 hardened there
// (sk-*, ASIA*, ghu_*, bare Bearer, URL-embedded credentials, PEM with
// dashes, AKIA). Then applies the legacy key=value replacement convention
// for AWS_*_KEY=, COSIGN_PASSWORD=, and other key=value assignments to
// preserve the legacy output shape for those forms.
import { redactSecrets as sharedRedact } from "./secret-redaction";

export function redactSecrets(text: string): string {
  if (!text) return text;

  // Step 1: apply shared redactor — covers sk-proj, ASIA, ghu, bare Bearer,
  // URL creds, PEM. These were the 7 classes confirmed missing pre-Phase-279.
  let result = sharedRedact(text);

  // Step 2: preserve legacy key=value convention for any remaining
  // assignments not caught by the shared redactor (AWS_*_KEY=, COSIGN_PASSWORD=).
  const legacyPatterns = [
    /AWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi,
    /AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/gi,
    /AWS_SESSION_TOKEN\s*[:=]\s*\S+/gi,
    /COSIGN_PASSWORD\s*=\s*\S+/gi,
    /password\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /api[_-]?key\s*[:=]\s*\S+/gi,
    /Authorization\s*[:=]\s*\S+/gi,
    /github[_-]?token\s*[:=]\s*\S+/gi,
    /gitlab[_-]?token\s*[:=]\s*\S+/gi,
  ];

  for (const pattern of legacyPatterns) {
    result = result.replace(pattern, (match) => {
      const keyMatch = match.match(/^[^:=]*/);
      const key = keyMatch ? keyMatch[0] : "SECRET";
      return `${key}=***REDACTED***`;
    });
  }

  return result;
}
