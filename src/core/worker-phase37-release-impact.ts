import { randomUUID } from 'crypto';
export function processReleaseImpact(input: any): any {
  let blastRadius = 'LOW';
  if (input.critical) blastRadius = 'CRITICAL';
  else if (input.high) blastRadius = 'HIGH';
  else if (input.medium) blastRadius = 'MEDIUM';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    affectedServices: input.affectedServices || [],
    affectedEnvironments: input.affectedEnvironments || [],
    blastRadius,
  };
}
