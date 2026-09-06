import { randomUUID } from 'crypto';
export function processReleaseStrategy(input: any): any {
  const risk = input.risk || 'UNKNOWN';
  const blastRadius = input.blastRadius || 'LOW';
  let strategy = 'ROLLING';
  if (risk === 'CRITICAL' || blastRadius === 'CRITICAL') strategy = 'CANARY';
  else if (risk === 'HIGH' || blastRadius === 'HIGH') strategy = 'PROGRESSIVE';
  else if (risk === 'MEDIUM') strategy = 'ROLLING';
  else strategy = 'DIRECT';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    strategy,
    reasons: input.reasons || [],
  };
}
