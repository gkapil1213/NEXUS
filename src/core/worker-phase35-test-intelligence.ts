import { randomUUID } from 'crypto';

export function processTestIntelligence(input: any): any {
  const result: any = {
    id: randomUUID(),
    buildId: input.buildId,
    passCount: input.passCount || 0,
    failCount: input.failCount || 0,
  };
  if ((input.failCount || 0) > 0) result.hasFailures = true;
  if (input.flaky) result.isFlaky = true;
  if (input.regression) result.isRegression = true;
  if (input.classification) result.classification = input.classification;
  return result;
}
