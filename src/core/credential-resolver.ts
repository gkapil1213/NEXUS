export interface CredentialReference {
  ref: string;
}

export interface CredentialProvider {
  resolve(ref: string): string | undefined;
}

export class EnvironmentCredentialProvider implements CredentialProvider {
  resolve(ref: string): string | undefined {
    return process.env[ref];
  }
}

export class CredentialResolver {
  constructor(private providers: CredentialProvider[]) {}

  resolve(ref: string): string | undefined {
    for (const provider of this.providers) {
      const value = provider.resolve(ref);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  redact(secret: string): string {
    return secret ? "***REDACTED***" : secret;
  }
}
