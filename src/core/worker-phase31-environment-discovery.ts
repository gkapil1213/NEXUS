import { createPlatformEnvironment } from './worker-phase31-environment';

export interface DiscoveryResult {
  environments: ReturnType<typeof createPlatformEnvironment>[];
  providerStatus: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
  reason?: string;
}

export function discoverEnvironments(
  providerStatus: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE',
  discovered: Omit<Parameters<typeof createPlatformEnvironment>[0], 'idempotencyKey'>[]
): DiscoveryResult {
  if (providerStatus !== 'CONFIGURED') {
    return { environments: [], providerStatus, reason: providerStatus === 'UNCONFIGURED' ? 'provider not configured' : 'provider unavailable' };
  }
  const envs = discovered.map(env => createPlatformEnvironment(env));
  return { environments: envs, providerStatus, reason: 'OK' };
}
