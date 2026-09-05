export interface SecretMetadata {
  secretId: string;
  owner: string;
  provider: string;
  environment: string;
  scope: string;
  rotationPolicy: string;
  expiresAt: string;
  status: string;
  version: number;
  lastRotatedAt?: string;
  nextRotationAt?: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createSecretMetadata(input: Omit<SecretMetadata, 'createdAt' | 'idempotencyKey'> & { idempotencyKey?: string }): SecretMetadata {
  const idempotencyKey = input.idempotencyKey ?? `${input.provider}:${input.environment}:${input.scope}`;
  return { ...input, createdAt: new Date().toISOString(), idempotencyKey };
}
