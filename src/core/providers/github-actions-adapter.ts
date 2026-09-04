import { CICDProvider } from "../cicd-provider";
import { CredentialResolver } from "../credential-resolver";

export class GitHubActionsAdapter implements CICDProvider {
  id = "github-actions";
  constructor(
    private config: { tokenRef?: string; repo?: string; owner?: string; baseUrl?: string } = {},
    private credentialResolver?: CredentialResolver
  ) {}

  private getToken(): string | undefined {
    if (!this.config.tokenRef || !this.credentialResolver) return undefined;
    return this.credentialResolver.resolve(this.config.tokenRef);
  }

  validateRequest(request: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!request.workflow) errors.push("workflow is required");
    if (!request.ref) errors.push("ref is required");
    if (!this.config.tokenRef || !this.credentialResolver) errors.push("GitHub token reference not configured");
    else if (!this.getToken()) errors.push("GitHub token not available in environment");
    return { valid: errors.length === 0, errors };
  }

  async trigger(request: any): Promise<{ externalRunId: string }> {
    const validation = this.validateRequest(request);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    throw new Error("GitHub Actions execution not available in this environment (no live network integration)");
  }

  async getStatus(externalRunId: string): Promise<{ status: string; logs?: string; evidence?: any }> {
    throw new Error("GitHub Actions status not available in this environment");
  }

  async cancel(externalRunId: string): Promise<void> {
    throw new Error("GitHub Actions cancellation not available in this environment");
  }
}
