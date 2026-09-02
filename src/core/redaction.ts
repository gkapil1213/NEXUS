export function redactSecrets(text: string): string {
  const secretPatterns = [
    /AWS_SECRET_ACCESS_KEY\s*[:=]\s*\S+/gi,
    /AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/gi,
    /AWS_SESSION_TOKEN\s*[:=]\s*\S+/gi,
    /AKIA[0-9A-Z]{16}/gi,
    /COSIGN_PASSWORD\s*=\s*\S+/gi,
    /password\s*[:=]\s*\S+/gi,
    /token\s*[:=]\s*\S+/gi,
    /api[_-]?key\s*[:=]\s*\S+/gi,
    /BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?END [A-Z ]*PRIVATE KEY/gi,
    /github[_-]?token\s*[:=]\s*\S+/gi,
    /gitlab[_-]?token\s*[:=]\s*\S+/gi,
  ];
  let result = text;
  for (const pattern of secretPatterns) {
    result = result.replace(pattern, (match) => {
      const keyMatch = match.match(/^[^:=]*/);
      const key = keyMatch ? keyMatch[0] : "SECRET";
      return `${key}=***REDACTED***`;
    });
  }
  return result;
}
