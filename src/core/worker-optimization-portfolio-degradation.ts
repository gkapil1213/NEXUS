export type DegradationLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DegradationInput {
  performanceDrop: number;
  repeatedFailures: number;
  correlation: number;
  diversityCollapse: boolean;
  budgetPressure: number;
  confidenceCollapse: boolean;
  evidenceDeterioration: boolean;
}

export function detectDegradation(input: DegradationInput): DegradationLevel {
  if (input.diversityCollapse || input.confidenceCollapse || input.evidenceDeterioration) return 'CRITICAL';
  if (input.performanceDrop > 0.3 || input.repeatedFailures > 5) return 'HIGH';
  if (input.budgetPressure > 0.8 || input.correlation > 0.7) return 'MEDIUM';
  if (input.performanceDrop > 0.1) return 'LOW';
  return 'NONE';
}
