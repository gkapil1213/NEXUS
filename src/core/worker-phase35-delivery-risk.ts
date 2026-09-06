import { randomUUID } from 'crypto';

export function processDeliveryRisk(input: any): any {
  const result: any = {
    id: randomUUID(),
    pipelineId: input.pipelineId,
  };
  if (input.critical) {
    result.riskLevel = 'CRITICAL';
  } else if (input.factors && input.factors.length > 0) {
    result.riskLevel = 'MEDIUM';
  } else {
    result.riskLevel = 'UNKNOWN';
  }
  return result;
}
