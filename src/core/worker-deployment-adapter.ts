export interface DeploymentAdapter {
  validateTarget(): Promise<{ ok: boolean; reason: string }>;
  checkAvailability(): Promise<{ available: boolean; reason: string }>;
  preflight(): Promise<{ ok: boolean; reason: string }>;
  deploy(artifactRef: string, version: string): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  getStatus(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED' | 'UNKNOWN'; details: string }>;
  getHealth(): Promise<{ healthy: boolean; reason: string }>;
  pause(): Promise<{ success: boolean; reason: string }>;
  resume(): Promise<{ success: boolean; reason: string }>;
  promote(): Promise<{ success: boolean; reason: string }>;
  rollback(previousVersion: string): Promise<{ success: boolean; reason: string }>;
}

export const unavailableDeploymentAdapter: DeploymentAdapter = {
  async validateTarget() { return { ok: false, reason: 'deployment adapter unavailable' }; },
  async checkAvailability() { return { available: false, reason: 'unavailable' }; },
  async preflight() { return { ok: false, reason: 'unavailable' }; },
  async deploy() { return { success: false, reason: 'unavailable', evidence: [] }; },
  async getStatus() { return { status: 'UNAVAILABLE', details: 'no adapter configured' }; },
  async getHealth() { return { healthy: false, reason: 'unavailable' }; },
  async pause() { return { success: false, reason: 'unavailable' }; },
  async resume() { return { success: false, reason: 'unavailable' }; },
  async promote() { return { success: false, reason: 'unavailable' }; },
  async rollback() { return { success: false, reason: 'unavailable' }; },
};
