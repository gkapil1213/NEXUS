import { randomUUID } from 'crypto';
export function processReleaseRisk(input: any): any {
  let riskLevel = 'UNKNOWN';
  if (input.critical) riskLevel = 'CRITICAL';
  else if (input.high) riskLevel = 'HIGH';
  else if (input.medium) riskLevel = 'MEDIUM';
  else if (input.low) riskLevel = 'LOW';
  return {
    id: randomUUID(),
    candidateId: input.candidateId,
    riskLevel,
    riskReasons: input.reasons || [],
    confidence: input.confidence || 0.5,
    recommendedStrategy: input.strategy || 'CANARY',
  };
}
