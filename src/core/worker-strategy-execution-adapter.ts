export type ExecutionProviderResult = 'SUCCESS' | 'FAILED' | 'UNAVAILABLE' | 'NOT_EXECUTED';

export interface ExecutionAdapter {
  validateAction(action: string, params: Record<string, unknown>): Promise<ExecutionProviderResult>;
  executeAction(action: string, params: Record<string, unknown>): Promise<ExecutionProviderResult>;
  pauseAction(action: string): Promise<ExecutionProviderResult>;
  resumeAction(action: string): Promise<ExecutionProviderResult>;
  rollbackAction(action: string): Promise<ExecutionProviderResult>;
  verifyAction(action: string): Promise<ExecutionProviderResult>;
}

export const unavailableExecutionAdapter: ExecutionAdapter = {
  async validateAction() { return 'UNAVAILABLE'; },
  async executeAction() { return 'UNAVAILABLE'; },
  async pauseAction() { return 'UNAVAILABLE'; },
  async resumeAction() { return 'UNAVAILABLE'; },
  async rollbackAction() { return 'UNAVAILABLE'; },
  async verifyAction() { return 'UNAVAILABLE'; },
};