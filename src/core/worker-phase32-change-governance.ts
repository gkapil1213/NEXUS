export interface ChangeGovernance {
  changeId: string;
  actor: string;
  resourceId: string;
  environment: string;
  fleetId: string;
  releaseId: string;
  deploymentId: string;
  incidentId: string;
  risk: string;
  policyId: string;
  approvalId: string;
  changeTime: string;
  idempotencyKey: string;
}

export function createChangeGovernance(input: Omit<ChangeGovernance, 'idempotencyKey'> & { idempotencyKey?: string }): ChangeGovernance {
  const idempotencyKey = input.idempotencyKey ?? `${input.changeId}:${input.resourceId}`;
  return { ...input, idempotencyKey };
}
