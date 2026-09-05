import { randomUUID } from 'crypto';

export interface EmergencyAuthorization {
  emergencyId: string;
  actorId: string;
  role: string;
  reason: string;
  scope: string;
  expiresAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  idempotencyKey: string;
}

export function createEmergencyAuthorization(
  input: Omit<EmergencyAuthorization, 'emergencyId' | 'createdAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }
): EmergencyAuthorization {
  const idempotencyKey = input.idempotencyKey ?? `${input.actorId}:${input.scope}:${input.reason}`;
  return {
    emergencyId: randomUUID(),
    ...input,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    idempotencyKey,
  };
}

export function isEmergencyValid(emergency: EmergencyAuthorization): boolean {
  return emergency.status === 'ACTIVE' && new Date(emergency.expiresAt) > new Date();
}
