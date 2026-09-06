import { randomUUID } from 'crypto';
export function processReleaseGovernance(input: any): any {
  let decision = 'ALLOW';
  if (input.freeze) decision = 'FREEZE';
  else if (input.deny) decision = 'DENY';
  else if (input.approvalRequired || input.risk === 'HIGH' || input.risk === 'CRITICAL') decision = 'REQUIRE_APPROVAL';
  return { id: randomUUID(), releaseId: input.releaseId, decision, reasons: input.reasons || [] };
}
