export interface ResourceOwnership {
  resourceId: string;
  owner: string;
  teamOwner: string;
  serviceOwner: string;
  costOwner: string;
  securityOwner: string;
  complianceOwner: string;
}

export function createResourceOwnership(input: ResourceOwnership): ResourceOwnership {
  return input;
}

export function isOrphan(ownership: ResourceOwnership): boolean {
  return !ownership.owner || ownership.owner.trim() === '';
}
