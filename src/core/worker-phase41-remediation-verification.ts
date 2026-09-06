import { randomUUID } from 'crypto';
export function processRemediationVerification(input: any): any {
  let state = 'unknown';
  if (input.healthResult === 'healthy' && input.sloResult === 'compliant') state = 'recovered';
  else if (input.healthResult === 'degraded') state = 'partially_recovered';
  else if (input.healthResult === 'unhealthy') state = 'not_recovered';
  else if (input.regression) state = 'regressed';
  return { id: randomUUID(), executionId: input.executionId, healthResult: input.healthResult || null, sloResult: input.sloResult || null, verificationState: state, evidenceRef: input.evidenceRef || null };
}
