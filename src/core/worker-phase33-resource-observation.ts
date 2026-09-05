export interface ResourceObservation {
  observationId: string;
  resourceId: string;
  observedAt: string;
  state: Record<string, unknown>;
  providerStatus: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
}

export function createResourceObservation(resourceId: string, state: Record<string, unknown>, providerStatus: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE'): ResourceObservation {
  return { observationId: `obs-${resourceId}-${Date.now()}`, resourceId, observedAt: new Date().toISOString(), state, providerStatus };
}
