export interface SecretReference {
  referenceId: string;
  provider: string;
  secretName: string;
  version?: string;
  resolved: boolean;
}

export function isSecretResolved(ref: SecretReference): boolean {
  return ref.resolved;
}
