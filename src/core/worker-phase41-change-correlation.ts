import { randomUUID } from 'crypto';
export function processChangeCorrelation(input: any): any {
  let strength = 'unknown';
  if (input.noCorrelation) strength = 'none';
  else if (input.correlationStrength) strength = input.correlationStrength;
  return { id: randomUUID(), serviceId: input.serviceId, changeRef: input.changeRef, correlationStrength: strength, confidence: input.confidence || 0 };
}
