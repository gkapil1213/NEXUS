export function evaluateAccessSafety(input: { protectedIdentity: boolean; privilegeEscalation: boolean; unknownProvider: boolean; unknownAuthorization: boolean; unsafeRevocation: boolean }): { allowed: boolean; reason: string } {
  if (input.protectedIdentity) return { allowed: false, reason: 'protected identity' };
  if (input.privilegeEscalation) return { allowed: false, reason: 'privilege escalation' };
  if (input.unknownProvider) return { allowed: false, reason: 'unknown provider' };
  if (input.unknownAuthorization) return { allowed: false, reason: 'unknown authorization' };
  if (input.unsafeRevocation) return { allowed: false, reason: 'unsafe revocation' };
  return { allowed: true, reason: 'OK' };
}
