import { randomUUID } from 'crypto';
export function processSecuritySafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownPosture) { safe = false; reasons.push('unknown posture'); }
  if (input.missingRollback) { safe = false; reasons.push('missing rollback'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), assetId: input.assetId, safe, reasons };
}
