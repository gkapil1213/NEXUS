import { randomUUID } from 'crypto';

export function processChangeCorrelation(input: any): any {
  const result: any = {
    id: randomUUID(),
    changeRef: input.changeRef,
  };
  if (input.noCorrelation) {
    result.correlation = 'NO_CORRELATION';
  } else if (input.changeRef === 'unknown') {
    result.correlation = 'UNKNOWN';
  } else {
    result.correlation = 'CORRELATED';
  }
  return result;
}
