export interface FleetSafetyInput {
  destructiveAction: boolean;
  uncontrolledProduction: boolean;
  crossEnvironmentContamination: boolean;
  unsafeFleetWideChange: boolean;
  unsafeRollback: boolean;
  unknownDependency: boolean;
  providerUnavailable: boolean;
}

export function evaluateFleetSafety(input: FleetSafetyInput): { allowed: boolean; reason: string } {
  if (input.destructiveAction) return { allowed: false, reason: 'destructive action' };
  if (input.uncontrolledProduction) return { allowed: false, reason: 'uncontrolled production expansion' };
  if (input.crossEnvironmentContamination) return { allowed: false, reason: 'cross-environment contamination' };
  if (input.unsafeFleetWideChange) return { allowed: false, reason: 'unsafe fleet-wide change' };
  if (input.unsafeRollback) return { allowed: false, reason: 'unsafe rollback' };
  if (input.unknownDependency) return { allowed: false, reason: 'unknown dependency' };
  if (input.providerUnavailable) return { allowed: false, reason: 'provider unavailable' };
  return { allowed: true, reason: 'OK' };
}
