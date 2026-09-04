export interface WorkerConfig {
  workerId: string;
  credentialRef: string;
  capabilities: string[];
  controlPlaneUrl?: string;
  hostname?: string;
  platform?: string;
  architecture?: string;
  agentVersion?: string;
  heartbeatIntervalMs?: number;
  executionTimeoutMs?: number;
  executionRoot?: string;
  envAllowlist?: string[];
  allowedOperations?: string[];
  allowedExecutables?: string[];
}
