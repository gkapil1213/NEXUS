export type DeploymentTargetStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED' | 'UNKNOWN';

export interface DeploymentTargetAdapter {
  preflight(): Promise<{ ok: boolean; reason: string }>;
  capabilityDetect(): Promise<Record<string, boolean>>;
  deploy(artifact: string, version: string): Promise<{ success: boolean; reason: string; evidence: string[] }>;
  status(): Promise<{ status: DeploymentTargetStatus; details: string }>;
  health(): Promise<{ healthy: boolean; reason: string }>;
  logs(): Promise<string[]>;
  rollback(version: string): Promise<{ success: boolean; reason: string }>;
  cleanup(): Promise<{ success: boolean; reason: string }>;
}

export const unavailableDeploymentTarget: DeploymentTargetAdapter = {
  async preflight() { return { ok: false, reason: 'deployment target unavailable' }; },
  async capabilityDetect() { return {}; },
  async deploy() { return { success: false, reason: 'unavailable', evidence: [] }; },
  async status() { return { status: 'UNAVAILABLE', details: 'no adapter configured' }; },
  async health() { return { healthy: false, reason: 'unavailable' }; },
  async logs() { return []; },
  async rollback() { return { success: false, reason: 'unavailable' }; },
  async cleanup() { return { success: false, reason: 'unavailable' }; },
};
