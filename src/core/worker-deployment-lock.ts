export interface DeploymentLock {
  lockId: string;
  environment: string;
  targetId: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  released: boolean;
  correlationId: string;
  idempotencyKey: string;
}

export function acquireDeploymentLock(
  environment: string,
  targetId: string,
  owner: string,
  ttlMs: number,
  correlationId: string,
  currentLock?: DeploymentLock
): { lock?: DeploymentLock; success: boolean; reason: string } {
  if (currentLock && !currentLock.released && currentLock.expiresAt > new Date().toISOString()) {
    return { success: false, reason: `locked by ${currentLock.owner}` };
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const lock: DeploymentLock = {
    lockId: `${environment}:${targetId}:${correlationId}`,
    environment,
    targetId,
    owner,
    acquiredAt: now.toISOString(),
    expiresAt,
    released: false,
    correlationId,
    idempotencyKey: `${environment}:${targetId}`,
  };
  return { lock, success: true, reason: 'acquired' };
}

export function releaseDeploymentLock(lock: DeploymentLock): DeploymentLock {
  return { ...lock, released: true };
}

export function isLockActive(lock: DeploymentLock): boolean {
  return !lock.released && lock.expiresAt > new Date().toISOString();
}
