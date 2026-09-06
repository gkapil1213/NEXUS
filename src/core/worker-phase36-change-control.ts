import { randomUUID } from 'crypto';
export function processChangeControl(input: any): any {
  let correlation = 'UNKNOWN';
  if (input.noCorrelation) correlation = 'NO_CORRELATION';
  else if (input.changeRef) correlation = 'CORRELATED';
  return { id: randomUUID(), changeRef: input.changeRef, correlation };
}
