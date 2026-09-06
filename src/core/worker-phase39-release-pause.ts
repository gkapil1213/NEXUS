import { randomUUID } from 'crypto';
export function processReleasePause(input: any): any {
  return { id: randomUUID(), releaseId: input.releaseId, reason: input.reason || 'manual', createdAt: new Date().toISOString() };
}
