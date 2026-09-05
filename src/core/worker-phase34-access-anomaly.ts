export interface AccessAnomaly {
  anomalyId: string;
  identityId: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: number;
}

export function detectAccessAnomaly(input: { privileged: boolean; unusualResource: boolean; unusualEnvironment: boolean; unexpectedIdentity: boolean }): AccessAnomaly | null {
  const flags = [input.privileged, input.unusualResource, input.unusualEnvironment, input.unexpectedIdentity];
  const count = flags.filter(Boolean).length;
  if (count === 0) return null;
  return { anomalyId: `anomaly-${Date.now()}`, identityId: 'unknown', type: 'privilege', severity: count > 2 ? 'CRITICAL' : 'HIGH', confidence: 0.7 };
}
