import { randomUUID } from 'crypto';
export function processProvider(input: any): any {
  if (input.unknown) throw new Error('Provider UNAVAILABLE');
  const capabilities = input.capabilities || ['discover','observe','optimize'];
  return { id: randomUUID(), name: input.name || 'provider', capabilities };
}
