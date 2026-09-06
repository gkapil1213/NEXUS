import { randomUUID } from 'crypto';
export function processRecoveryVerification(input: any): any {
  let state = 'unknown';
  if (input.healthResult === 'HEALTHY' && input.sloResult === 'OK') state = 'recovered';
  else if (input.regressionResult === true) state = 'regressed';
  else if (input.healthResult === 'UNHEALTHY') state = 'failed';
  else if (input.healthResult === 'DEGRADED') state = 'recovering';
  return {
    id: randomUUID(),
    incidentId: input.incidentId,
    executionId: input.executionId || null,
    healthResult: input.healthResult || null,
    sloResult: input.sloResult || null,
    regressionResult: input.regressionResult || null,
    verificationState: state,
    evidenceRef: input.evidenceRef || null,
  };
}
