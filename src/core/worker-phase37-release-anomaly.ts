import { randomUUID } from 'crypto';
export function processReleaseAnomaly(input: any): any {
  let severity = 'NORMAL';
  if (input.critical) severity = 'CRITICAL';
  else if (input.warning) severity = 'WARNING';
  return {
    id: randomUUID(),
    releaseId: input.releaseId,
    anomalyType: input.anomalyType || 'generic',
    severity,
  };
}
