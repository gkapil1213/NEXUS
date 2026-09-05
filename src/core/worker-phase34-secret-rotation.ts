import { randomUUID } from 'crypto';

export type RotationStatus = 'PLANNED' | 'APPROVED' | 'EXECUTING' | 'VERIFIED' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface SecretRotation {
  rotationId: string;
  secretId: string;
  status: RotationStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
}

const VALID_TRANSITIONS: Record<RotationStatus, RotationStatus[]> = {
  PLANNED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  FAILED: ['ROLLED_BACK', 'CANCELLED'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function createSecretRotation(input: Omit<SecretRotation, 'rotationId' | 'createdAt' | 'updatedAt' | 'status' | 'idempotencyKey'> & { idempotencyKey?: string }): SecretRotation {
  const idempotencyKey = input.idempotencyKey ?? input.secretId;
  const now = new Date().toISOString();
  return { rotationId: randomUUID(), ...input, status: 'PLANNED', createdAt: now, updatedAt: now, idempotencyKey };
}

export function transitionSecretRotation(rot: SecretRotation, next: RotationStatus): SecretRotation {
  if (!VALID_TRANSITIONS[rot.status].includes(next)) throw new Error(`Illegal secret rotation transition ${rot.status}->${next}`);
  return { ...rot, status: next, updatedAt: new Date().toISOString() };
}
