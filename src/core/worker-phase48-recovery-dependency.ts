import { randomUUID } from 'crypto';
export function processRecoveryDependency(input: any): any {
  return {
    id: randomUUID(),
    sourceAssetId: input.sourceAssetId,
    targetAssetId: input.targetAssetId,
    relationship: input.relationship || 'depends_on',
  };
}
