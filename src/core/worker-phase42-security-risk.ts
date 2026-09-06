import { randomUUID } from 'crypto';
export function processSecurityRisk(input: any): any {
  let severity = 'unknown';
  if (input.critical) severity = 'critical';
  else if (input.high) severity = 'high';
  else if (input.medium) severity = 'medium';
  else if (input.low) severity = 'low';
  return { id: randomUUID(), assetId: input.assetId, severity, confidence: input.confidence || 0 };
}
