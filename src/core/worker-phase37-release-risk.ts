import { randomUUID } from 'crypto';
export function processReleaseRisk(input: any): any {
  let riskLevel = 'UNKNOWN';
  if (input.critical) riskLevel = 'CRITICAL';
  else if (input.high) riskLevel = 'HIGH';
  else if (input.medium) riskLevel = 'MEDIUM';
  else if (input.low) riskLevel = 'LOW';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    riskLevel,
    reasons: input.reasons || [],
    confidence: input.confidence || 0.5,
  };
}
