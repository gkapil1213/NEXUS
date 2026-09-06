import { randomUUID } from 'crypto';
export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  const capabilities = input.capabilities || ['discoverResources','observeResource','getCapacity','scaleResource'];
  return { id: randomUUID(), name: input.name || 'provider', capabilities };
}
