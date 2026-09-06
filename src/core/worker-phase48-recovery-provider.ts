import { randomUUID } from 'crypto';
export function processRecoveryProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  const capabilities = input.capabilities || ['backup_listing','restore','failover'];
  return { id: randomUUID(), name: input.name || 'provider', capabilities };
}
