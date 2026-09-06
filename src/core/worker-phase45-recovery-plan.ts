import { randomUUID } from 'crypto';
export function processRecoveryPlan(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    serviceId: input.serviceId,
    failureId: input.failureId || null,
    strategy: input.strategy || null,
    dependencyOrder: input.dependencyOrder || [],
    actions: input.actions || [],
    approvalRequired: input.approvalRequired || false,
    safetyConditions: input.safetyConditions || null,
    expectedOutcome: input.expectedOutcome || null,
    rtoTarget: input.rtoTarget || null,
    rpoTarget: input.rpoTarget || null,
  };
}
