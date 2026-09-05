export function detectOrphanedIdentity(owner: string, workloadAssigned: boolean, active: boolean): boolean {
  return (!owner || owner.trim() === '') || !workloadAssigned || !active;
}
