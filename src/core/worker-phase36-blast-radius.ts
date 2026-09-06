import { randomUUID } from 'crypto';
export function processBlastRadius(input: any): any {
  let level = 'LOW';
  if (input.critical) level = 'CRITICAL';
  else if (input.high) level = 'HIGH';
  else if (input.medium) level = 'MEDIUM';
  return { id: randomUUID(), level };
}
