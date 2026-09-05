export interface Phase26Provider {
  executeAction(action: string, params: Record<string, unknown>): Promise<{ success: boolean; reason: string; evidence: string[] }>;
}

export const unavailablePhase26Provider: Phase26Provider = {
  async executeAction() { return { success: false, reason: 'unavailable', evidence: [] }; },
};
