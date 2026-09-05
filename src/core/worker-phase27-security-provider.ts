export interface SecurityProvider {
  scan(): Promise<{ status: 'SUCCESS' | 'UNCONFIGURED' | 'UNAVAILABLE'; findings?: any[] }>;
}

export const unconfiguredSecurityProvider: SecurityProvider = {
  async scan() { return { status: 'UNCONFIGURED' }; },
};
