import { randomUUID } from 'crypto';

export function processPipelinePerformance(input: any): any {
  const result: any = {
    id: randomUUID(),
    pipelineId: input.pipelineId,
  };
  if (input.avgDurationMs && input.avgDurationMs > 60000) result.isSlow = true;
  if (input.queueTimeMs && input.queueTimeMs > 60000) result.queueAnomaly = true;
  if (input.durationMs && input.durationMs > 60000) result.durationAnomaly = true;
  if (input.severity) result.severity = input.severity;
  return result;
}
