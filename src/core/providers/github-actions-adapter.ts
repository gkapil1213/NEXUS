import { CICDProvider } from "../cicd-provider";

export class GitHubActionsAdapter implements CICDProvider {
  id = "github-actions";
  constructor(private config: { token?: string; repo?: string; owner?: string; baseUrl?: string } = {}) {}

  validateRequest(request: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!request.workflow) errors.push("workflow is required");
    if (!request.ref) errors.push("ref is required");
    if (!this.config.token) errors.push("GitHub token not configured");
    return { valid: errors.length === 0, errors };
  }

  async trigger(request: any): Promise<{ externalRunId: string }> {
    const validation = this.validateRequest(request);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    throw new Error("GitHub Actions execution not available in this environment (no credentials or network)");
  }

  async getStatus(externalRunId: string): Promise<{ status: string; logs?: string; evidence?: any }> {
    throw new Error("GitHub Actions status not available in this environment");
  }

  async cancel(externalRunId: string): Promise<void> {
    throw new Error("GitHub Actions cancellation not available in this environment");
  }
}
