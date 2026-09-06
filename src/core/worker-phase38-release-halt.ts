import { randomUUID } from 'crypto';
export function processReleaseHalt(input: any): any {
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    reason: input.reason || 'manual',
    status: 'HALTED',
    createdAt: new Date().toISOString(),
  };
}
