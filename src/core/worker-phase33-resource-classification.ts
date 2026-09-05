export function classifyResource(input: { lifecycleState: string; criticality: string; environment: string }): 'PROTECTED' | 'STANDARD' | 'NON_CRITICAL' {
  if (input.criticality === 'CRITICAL' || input.environment === 'production') return 'PROTECTED';
  if (input.lifecycleState === 'STOPPED') return 'NON_CRITICAL';
  return 'STANDARD';
}
