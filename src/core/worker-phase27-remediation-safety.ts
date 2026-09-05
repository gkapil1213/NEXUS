export interface RemediationSafetyInput {
  blastRadius: number;
  reversibility: boolean;
  serviceCriticality: string;
  dependencyImpact: number;
  changeRisk: string;
  productionEnvironment: boolean;
  approvalRequired: boolean;
}

export function evaluateRemediationSafety(input: RemediationSafetyInput): { allowed: boolean; reason: string } {
  if (input.productionEnvironment && input.changeRisk === 'HIGH' && !input.approvalRequired) return { allowed: false, reason: 'high risk production change requires approval' };
  if (input.blastRadius > 5 || !input.reversibility) return { allowed: false, reason: 'high blast radius or irreversible' };
  return { allowed: true, reason: 'OK' };
}
