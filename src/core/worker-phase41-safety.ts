import { randomUUID } from 'crypto';
export function processSafety(input: any): any {
  let safe = true;
  const reasons: string[] = [];
  if (input.protectedResource) { safe = false; reasons.push('protected resource'); }
  if (input.unknownProvider) { safe = false; reasons.push('unknown provider'); }
  if (input.unknownHealth) { safe = false; reasons.push('unknown health'); }
  if (input.unknownRisk) { safe = false; reasons.push('unknown risk'); }
  if (input.excessiveBlastRadius) { safe = false; reasons.push('excessive blast radius'); }
  return { id: randomUUID(), serviceId: input.serviceId, safe, reasons };
}
