export interface ObjectiveInput {
  currentRpoSeconds: number;
  targetRpoSeconds: number;
  currentRtoSeconds: number;
  targetRtoSeconds: number;
}

export function evaluateObjectives(input: ObjectiveInput): { rpoMet: boolean; rtoMet: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.currentRpoSeconds > input.targetRpoSeconds) reasons.push('RPO not met');
  if (input.currentRtoSeconds > input.targetRtoSeconds) reasons.push('RTO not met');
  return { rpoMet: input.currentRpoSeconds <= input.targetRpoSeconds, rtoMet: input.currentRtoSeconds <= input.targetRtoSeconds, reasons };
}
