import { randomUUID } from 'crypto';

export interface ResponsePlan {
  planId: string;
  incidentId: string;
  actions: string[];
  risk: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createResponsePlan(input: Omit<ResponsePlan, 'planId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): ResponsePlan {
  const idempotencyKey = input.idempotencyKey ?? `${input.incidentId}:${input.actions.join(',')}`;
  return { planId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
