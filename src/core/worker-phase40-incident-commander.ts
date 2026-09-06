import { randomUUID } from 'crypto';
export function processIncidentCommander(input: any): any {
  const result: any = {
    id: randomUUID(),
    incidentId: input.incidentId,
    currentState: input.currentState || 'detected',
    targetState: input.targetState,
    validTransition: false,
  };
  const validTransitions: Record<string, string[]> = {
    detected: ['acknowledged','escalated','closed'],
    acknowledged: ['investigating','closed'],
    investigating: ['mitigating','escalated'],
    mitigating: ['recovering','escalated'],
    recovering: ['monitoring','resolved','halted'],
    monitoring: ['resolved','escalated'],
    resolved: ['closed','monitoring'],
    closed: [],
    escalated: ['investigating','closed'],
    halted: ['investigating','closed'],
  };
  if (input.currentState && input.targetState) {
    const allowed = validTransitions[input.currentState] || [];
    result.validTransition = allowed.includes(input.targetState);
    if (result.validTransition) result.currentState = input.targetState;
  }
  return result;
}
