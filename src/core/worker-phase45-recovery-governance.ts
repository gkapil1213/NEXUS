import { randomUUID } from 'crypto';
export function processRecoveryGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'high' || input.risk === 'critical') decision = 'APPROVAL_REQUIRED';
  return { id: randomUUID(), serviceId: input.serviceId, decision, reasons: input.reasons || [] };
}
