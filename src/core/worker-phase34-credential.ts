export interface Credential {
  credentialId: string;
  identityId: string;
  provider: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  scope: string;
  expiresAt: string;
  lastUsedAt?: string;
  rotationState: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createCredential(input: Omit<Credential, 'credentialId' | 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): Credential {
  const idempotencyKey = input.idempotencyKey ?? `${input.identityId}:${input.provider}:${input.scope}`;
  return { credentialId: `cred-${Date.now()}`, ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
