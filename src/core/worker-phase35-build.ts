import { randomUUID } from 'crypto';

export function processBuild(input: any): any {
  const result: any = {
    id: randomUUID(),
    pipelineId: input.pipelineId,
    status: input.status,
  };
  if (input.status === 'FAILED') result.isFailure = true;
  if (input.durationMs && input.durationMs > 600000) result.isAnomaly = true;
  if (input.status === 'TIMEOUT') result.isTimeout = true;
  if (input.isRegression) result.isRegression = true;
  return result;
}
