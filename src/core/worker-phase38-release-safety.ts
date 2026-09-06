import { randomUUID } from 'crypto';
export function processReleaseSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedEnvironment) { safe = false; reasons.push('protected environment'); }
  if (input.artifactMismatch) { safe = false; reasons.push('artifact mismatch'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.missingApproval) { safe = false; reasons.push('missing approval'); }
  if (input.activeIncident) { safe = false; reasons.push('active incident'); }
  if (input.rollbackUnavailable) { safe = false; reasons.push('rollback unavailable'); }
  return { id: randomUUID(), releaseId: input.releaseId, safe, reasons };
}
