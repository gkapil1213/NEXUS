import { randomUUID } from 'crypto';
export function processSlo(input: any): any {
  const id = input.idempotencyKey || randomUUID();
  let compliance = 'unknown';
  if (input.violated) compliance = 'violated';
  else if (input.atRisk) compliance = 'at_risk';
  else if (input.compliant) compliance = 'compliant';
  return {
    id,
    idempotencyKey: input.idempotencyKey || id,
    sliId: input.sliId,
    target: input.target,
    complianceState: compliance,
  };
}
