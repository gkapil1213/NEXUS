export interface RuntimeProvider {
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
  capabilities: string[];
  executeAction(action: string, params: Record<string, unknown>): Promise<{ success: boolean; reason: string }>;
}

export const unconfiguredRuntimeProvider: RuntimeProvider = {
  status: 'UNCONFIGURED',
  capabilities: [],
  async executeAction() { return { success: false, reason: 'provider unconfigured' }; },
};
