import { randomUUID } from 'crypto';
export function processRecoveryStrategy(input: any): any {
  const strategy = input.strategy || 'restart';
  return { id: randomUUID(), serviceId: input.serviceId, strategy, providerCapabilityRequired: input.providerCapabilityRequired || null };
}
