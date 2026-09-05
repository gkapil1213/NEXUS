export interface ReleaseFreezeRecord {
  freezeId: string;
  environment: string;
  reason: string;
  frozen: boolean;
  createdAt: string;
  idempotencyKey: string;
}

export function createReleaseFreeze(environment: string, reason: string): ReleaseFreezeRecord {
  return { freezeId: `freeze-${environment}-${Date.now()}`, environment, reason, frozen: true, createdAt: new Date().toISOString(), idempotencyKey: environment };
}

export function unfreezeRelease(freeze: ReleaseFreezeRecord): ReleaseFreezeRecord {
  return { ...freeze, frozen: false };
}
