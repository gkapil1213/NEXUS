export type FleetRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface FleetRiskInput {
  criticality: string;
  environment: string;
  dependencyCount: number;
  securityPosture: string;
  configDrift: string;
  versionDrift: string;
  health: string;
  incidentHistory: number;
  blastRadius: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  rollbackCapability: boolean;
}

export function assessFleetRisk(input: FleetRiskInput): FleetRiskLevel {
  if (input.securityPosture === 'CRITICAL' || input.incidentHistory > 3 || input.health === 'CRITICAL') return 'CRITICAL';
  if (input.configDrift === 'HIGH' || input.versionDrift === 'HIGH' || input.blastRadius === 'CRITICAL') return 'HIGH';
  if (input.blastRadius === 'HIGH' || input.dependencyCount > 5) return 'MEDIUM';
  if (!input.rollbackCapability) return 'HIGH';
  return 'LOW';
}
