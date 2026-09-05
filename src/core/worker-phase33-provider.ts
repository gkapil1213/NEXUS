export interface Provider {
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
  capabilities: string[];
  executeAction(action: string, params: Record<string, unknown>): Promise<{ success: boolean; reason: string }>;
}

export const unconfiguredProvider: Provider = {
  status: 'UNCONFIGURED',
  capabilities: [],
  async executeAction() { return { success: false, reason: 'provider unconfigured' }; },
};
