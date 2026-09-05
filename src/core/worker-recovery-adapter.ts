export interface RecoveryProviderAdapter {
  backup(): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  restore(): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  failover(): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  failback(): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  healthCheck(): Promise<{ healthy: boolean; reason: string }>;
}

export const unavailableRecoveryProvider: RecoveryProviderAdapter = {
  async backup() { return { success: false, reason: 'provider unavailable', evidence: [] }; },
  async restore() { return { success: false, reason: 'provider unavailable', evidence: [] }; },
  async failover() { return { success: false, reason: 'provider unavailable', evidence: [] }; },
  async failback() { return { success: false, reason: 'provider unavailable', evidence: [] }; },
  async healthCheck() { return { healthy: false, reason: 'provider unavailable' }; },
};
