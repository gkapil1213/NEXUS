export interface FleetMembership {
  membershipId: string;
  fleetId: string;
  resourceId: string;
  role: string;
  addedAt: string;
  idempotencyKey: string;
}

export function addFleetMember(fleetId: string, resourceId: string, role: string): FleetMembership {
  return {
    membershipId: `member-${fleetId}-${resourceId}`,
    fleetId,
    resourceId,
    role,
    addedAt: new Date().toISOString(),
    idempotencyKey: `${fleetId}:${resourceId}`,
  };
}
