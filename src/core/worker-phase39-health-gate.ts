import { randomUUID } from 'crypto';
export function processHealthGate(input: any): any {
  let decision = 'UNKNOWN';
  if (input.appHealth === 'HEALTHY' && input.infraHealth === 'HEALTHY' && input.deploymentHealth === 'HEALTHY') decision = 'ALLOW';
  else if (input.appHealth === 'UNHEALTHY' || input.infraHealth === 'UNHEALTHY' || input.deploymentHealth === 'UNHEALTHY') decision = 'HALT';
  else if (input.appHealth === 'DEGRADED' || input.infraHealth === 'DEGRADED') decision = 'PAUSE';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    decision,
  };
}
