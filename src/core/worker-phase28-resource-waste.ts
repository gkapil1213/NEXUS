export interface WasteCandidate {
  resourceId: string;
  type: 'IDLE' | 'UNDERUTILIZED' | 'ABANDONED' | 'OVER_PROVISIONED';
  utilization: number;
  reason: string;
}

export function detectWaste(input: { resourceId: string; utilization: number; idleDays: number }): WasteCandidate | null {
  if (input.utilization < 0.1) {
    const type = input.idleDays > 7 ? 'ABANDONED' : 'IDLE';
    return { resourceId: input.resourceId, type, utilization: input.utilization, reason: `utilization ${input.utilization}` };
  }
  if (input.utilization < 0.3) return { resourceId: input.resourceId, type: 'UNDERUTILIZED', utilization: input.utilization, reason: 'low utilization' };
  return null;
}
