export function redactSecrets(text: string): string {
  const secretPatterns = [
    /COSIGN_PASSWORD\s*=\s*\S+/gi,
    /password\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /api[_-]?key\s*[:=]\s*\S+/gi,
  ];
  let result = text;
  for (const pattern of secretPatterns) {
    result = result.replace(pattern, (match) => match.split(/[:=]/)[0] + "=***REDACTED***");
  }
  return result;
}