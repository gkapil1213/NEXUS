import { randomUUID } from 'crypto';
export function processRecoveryObjective(input: any): any {
  let rpoCompliance = 'unknown';
  let rtoCompliance = 'unknown';
  if (input.rpoTargetSeconds !== undefined && input.actualRpoSeconds !== undefined) {
    rpoCompliance = input.actualRpoSeconds <= input.rpoTargetSeconds ? 'compliant' : 'violated';
  }
  if (input.rtoTargetSeconds !== undefined && input.actualRtoSeconds !== undefined) {
    rtoCompliance = input.actualRtoSeconds <= input.rtoTargetSeconds ? 'compliant' : 'violated';
  }
  return { id: randomUUID(), assetId: input.assetId, rpoTargetSeconds: input.rpoTargetSeconds, rtoTargetSeconds: input.rtoTargetSeconds, rpoCompliance, rtoCompliance };
}
