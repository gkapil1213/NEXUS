import { randomUUID } from 'crypto';
export function processCapacityGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'high' || input.risk === 'critical') decision = 'APPROVAL_REQUIRED';
  return { id: randomUUID(), resourceId: input.resourceId, decision, reasons: input.reasons || [] };
}
