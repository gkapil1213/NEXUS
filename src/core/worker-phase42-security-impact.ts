import { randomUUID } from 'crypto';
export function processSecurityImpact(input: any): any {
  return { id: randomUUID(), affectedAssets: input.affectedAssets || [], affectedServices: input.affectedServices || [], affectedEnvironments: input.affectedEnvironments || [] };
}
