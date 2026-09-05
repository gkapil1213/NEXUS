export interface SecretRevocation {
  revocationId: string;
  secretId: string;
  reason: string;
  status: string;
  createdAt: string;
  idempotencyKey: string;
}

export function createSecretRevocation(secretId: string, reason: string): SecretRevocation {
  return { revocationId: `revoke-${secretId}-${Date.now()}`, secretId, reason, status: 'REQUESTED', createdAt: new Date().toISOString(), idempotencyKey: secretId };
}
