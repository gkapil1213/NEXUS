export interface RecoveryVerifier {
  verify(service: string, environment: string): Promise<boolean>;
}

export class PredicateRecoveryVerifier implements RecoveryVerifier {
  constructor(private predicate: (service: string, environment: string) => Promise<boolean>) {}

  async verify(service: string, environment: string): Promise<boolean> {
    return this.predicate(service, environment);
  }
}