import { randomUUID } from 'crypto';
export function processReleaseImpact(input: any): any {
  let blastRadius = 'LOW';
  if (input.critical) blastRadius = 'CRITICAL';
  else if (input.high) blastRadius = 'HIGH';
  else if (input.medium) blastRadius = 'MEDIUM';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    impactScore: input.impactScore || 0,
    blastRadius,
    affectedServices: input.affectedServices || [],
    affectedApplications: input.affectedApplications || [],
    affectedEnvironments: input.affectedEnvironments || [],
    affectedDatabases: input.affectedDatabases || [],
    affectedInfrastructure: input.affectedInfrastructure || [],
    affectedDependencies: input.affectedDependencies || [],
  };
}
