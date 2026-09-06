import { randomUUID } from 'crypto';
export function processSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.invalidCapacity) { safe = false; reasons.push('invalid capacity'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), resourceId: input.resourceId, safe, reasons };
}
