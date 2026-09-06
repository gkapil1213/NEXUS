import { randomUUID } from 'crypto';
export function processProvider(input: any): any {
  const capabilities = input.capabilities || ['release','progressive_delivery','rollback'];
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  return { id: randomUUID(), name: input.name || 'provider', capabilities };
}
