import { randomUUID } from 'crypto';

export interface Role {
  roleId: string;
  name: string;
  provider: string;
  protected: boolean;
  privileged: boolean;
  permissions: string[];
  version: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  createdAt: string;
  idempotencyKey: string;
}

export function createRole(input: Omit<Role, 'roleId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): Role {
  const idempotencyKey = input.idempotencyKey ?? `${input.name}:${input.provider}:${input.version}`;
  return { roleId: randomUUID(), ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
