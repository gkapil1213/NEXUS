import { randomUUID } from 'crypto';
export function processReleaseSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.missingRollback) { safe = false; reasons.push('missing rollback'); }
  if (input.criticalRisk) { safe = false; reasons.push('critical risk'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  if (input.governanceDenial) { safe = false; reasons.push('governance denial'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), releaseId: input.releaseId, safe, reasons };
}
