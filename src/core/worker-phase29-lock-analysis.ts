export interface LockObservation {
  lockId: string;
  resourceId: string;
  blockedOperation: string;
  blockingOperation: string;
  duration: number;
  deadlock: boolean;
  affectedResource: string;
  risk: string;
}

export function createLockObservation(input: LockObservation): LockObservation {
  return input;
}
