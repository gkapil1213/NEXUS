export interface DataProvider {
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'UNAVAILABLE';
  capabilities: string[];
  executeOperation(operation: string, params: Record<string, unknown>): Promise<{ success: boolean; reason: string }>;
}

export const unconfiguredDataProvider: DataProvider = {
  status: 'UNCONFIGURED',
  capabilities: [],
  async executeOperation() { return { success: false, reason: 'provider unconfigured' }; },
};
