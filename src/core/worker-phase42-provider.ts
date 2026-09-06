import { randomUUID } from 'crypto';
export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  const capabilities = input.capabilities || ['asset_discovery','posture','vulnerability','signal','remediation'];
  return { id: randomUUID(), name: input.name || 'provider', capabilities };
}
