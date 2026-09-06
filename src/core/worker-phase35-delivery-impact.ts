import { randomUUID } from 'crypto';

export function processDeliveryImpact(input: any): any {
  return {
    id: randomUUID(),
    pipelineId: input.pipelineId,
    blastRadius: input.blastRadius || null,
  };
}
