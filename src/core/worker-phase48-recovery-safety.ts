import { randomUUID } from 'crypto';
export function processRecoverySafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.unknownBackupIntegrity) { safe = false; reasons.push('unknown backup integrity'); }
  if (input.unsafePlan) { safe = false; reasons.push('unsafe recovery plan'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), assetId: input.assetId, safe, reasons };
}
