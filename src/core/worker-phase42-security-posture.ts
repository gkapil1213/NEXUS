import { randomUUID } from 'crypto';
export function processSecurityPosture(input: any): any {
  let posture = 'unknown';
  if (input.securityScore !== undefined) {
    if (input.securityScore >= 80) posture = 'secure';
    else if (input.securityScore >= 50) posture = 'at_risk';
    else posture = 'compromised';
  }
  return {
    id: randomUUID(),
    assetId: input.assetId,
    postureState: posture,
    securityScore: input.securityScore,
    exposureLevel: input.exposureLevel || null,
    controlStatus: input.controlStatus || null,
    observationTime: input.observationTime || new Date().toISOString(),
  };
}
