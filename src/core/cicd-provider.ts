export interface CICDProvider {
  id: string;
  trigger(request: any): Promise<{ externalRunId: string }>;
  getStatus(externalRunId: string): Promise<{ status: string; logs?: string; evidence?: any }>;
  cancel(externalRunId: string): Promise<void>;
  validateRequest(request: any): { valid: boolean; errors: string[] };
}
