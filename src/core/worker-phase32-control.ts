export interface GovernanceControl {
  controlId: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  requirement: string;
  policyMapping: string[];
  evidenceRequirement: string;
  evaluationFrequency: string;
  owner: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export function createGovernanceControl(input: GovernanceControl): GovernanceControl {
  return input;
}
