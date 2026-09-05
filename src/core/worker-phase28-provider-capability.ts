import { InfrastructureProvider } from './worker-phase28-provider';

export function isProviderCapable(provider: InfrastructureProvider, capability: string): boolean {
  return provider.status === 'CONFIGURED' && provider.capabilities.includes(capability);
}
