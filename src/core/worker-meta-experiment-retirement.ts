export function shouldRetireMethod(input: {
  methodId: string;
  effectiveness: number;
  repeatedFailures: number;
  rollbackCount: number;
  resourceInefficiency: number;
  obsolete: boolean;
  governanceAllowed: boolean;
}): boolean {
  if (!input.governanceAllowed) return false;
  return input.obsolete || input.repeatedFailures > 5 || input.rollbackCount > 5 || input.resourceInefficiency > 0.8 || input.effectiveness < 0.1;
}
