import { randomUUID } from 'crypto';
export function processDependency(input: any): any {
  return {
    id: randomUUID(),
    sourceServiceId: input.sourceServiceId,
    targetServiceId: input.targetServiceId,
    relationship: input.relationship || 'depends_on',
  };
}
