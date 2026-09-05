export interface GovernanceProvider {
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
  capabilities: string[];
  executeAction(action: string, params: Record<string, unknown>): Promise<{ success: boolean; reason: string }>;
}

export const unconfiguredGovernanceProvider: GovernanceProvider = {
  status: 'UNCONFIGURED',
  capabilities: [],
  async executeAction() { return { success: false, reason: 'provider unconfigured' }; },
};
