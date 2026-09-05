export function detectCredentialExpiry(credential: { expiresAt: string }): { expired: boolean; soonToExpire: boolean } {
  const now = new Date();
  const exp = new Date(credential.expiresAt);
  return { expired: exp <= now, soonToExpire: exp <= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) };
}
