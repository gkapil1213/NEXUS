import { randomUUID } from 'crypto';
export function processRemediationSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.insufficientEvidence) { safe = false; reasons.push('insufficient evidence'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), serviceId: input.serviceId, safe, reasons };
}
