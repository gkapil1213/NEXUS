import { randomUUID } from 'crypto';

export function processPipelineGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.protected) decision = 'DENY';
  else if (input.risk === 'HIGH' || input.risk === 'CRITICAL') decision = 'REQUIRES_APPROVAL';
  return { id: randomUUID(), decision };
}
