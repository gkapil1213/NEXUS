import { randomUUID } from 'crypto';
export function processRecoverySafety(input: any): any {
  let safe = true;
  const reasons = [];
  if (input.blockedResource) { safe = false; reasons.push('blocked resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownReadiness) { safe = false; reasons.push('unknown readiness'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), serviceId: input.serviceId, safe, reasons };
}
