/**
 * Phase 105: optional context for provider status/cancel calls. GitHub's
 * Actions API addresses runs by (owner, repo, run_id) — without owner/repo
 * a provider cannot safely query or cancel a specific run. Providers that
 * do not need this context may ignore it.
 */
export interface CICDStatusContext {
  owner?: string;
  repo?: string;
}

export interface CICDProvider {
  id: string;
  trigger(request: any): Promise<{ externalRunId: string }>;
  getStatus(externalRunId: string, ctx?: CICDStatusContext): Promise<{ status: string; logs?: string; evidence?: any }>;
  cancel(externalRunId: string, ctx?: CICDStatusContext): Promise<void>;
  validateRequest(request: any): { valid: boolean; errors: string[] };
}
