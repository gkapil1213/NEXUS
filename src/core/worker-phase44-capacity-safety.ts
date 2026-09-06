import { randomUUID } from 'crypto';
export function processCapacitySafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownResource) { safe = false; reasons.push('unknown resource'); }
  if (input.unknownCapacity) { safe = false; reasons.push('unknown capacity'); }
  if (input.insufficientForecast) { safe = false; reasons.push('insufficient forecast'); }
  if (input.missingApproval) { safe = false; reasons.push('missing approval'); }
  if (input.circuitBreakerOpen) { safe = false; reasons.push('circuit breaker open'); }
  return { id: randomUUID(), resourceId: input.resourceId, safe, reasons };
}
