export interface AllocationRequest {
  experimentBudget: number;
  computeBudget: number;
  concurrency: number;
  rolloutCapacity: number;
  evaluationCapacity: number;
  evidenceCollectionCapacity: number;
}

export interface AllocationState {
  available: AllocationRequest;
  reserved: AllocationRequest;
}

export function allocateResources(state: AllocationState, request: Partial<AllocationRequest>): { allowed: boolean; reason: string; state: AllocationState } {
  for (const key of Object.keys(request) as (keyof AllocationRequest)[]) {
    const needed = request[key] ?? 0;
    const available = state.available[key] ?? 0;
    if (needed > available) return { allowed: false, reason: `insufficient ${key}`, state };
  }
  const newAvailable = { ...state.available };
  const newReserved = { ...state.reserved };
  for (const key of Object.keys(request) as (keyof AllocationRequest)[]) {
    const needed = request[key] ?? 0;
    newAvailable[key] -= needed;
    newReserved[key] += needed;
  }
  return { allowed: true, reason: 'OK', state: { available: newAvailable, reserved: newReserved } };
}
