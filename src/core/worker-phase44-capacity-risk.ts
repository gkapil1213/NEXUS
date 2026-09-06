import { randomUUID } from 'crypto';
export function processCapacityRisk(input: any): any {
  let riskLevel = 'unknown';
  if (input.critical) riskLevel = 'critical';
  else if (input.high) riskLevel = 'high';
  else if (input.medium) riskLevel = 'medium';
  else if (input.low) riskLevel = 'low';
  return { id: randomUUID(), resourceId: input.resourceId, riskLevel, reasons: input.reasons || [] };
}
