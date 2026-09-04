import { CICDProvider } from "../cicd-provider";
import { CredentialResolver } from "../credential-resolver";

export class JenkinsAdapter implements CICDProvider {
  id = "jenkins";
  constructor(
    private config: { baseUrl?: string; usernameRef?: string; tokenRef?: string } = {},
    private credentialResolver?: CredentialResolver
  ) {}

  private getToken(): string | undefined {
    if (!this.config.tokenRef || !this.credentialResolver) return undefined;
    return this.credentialResolver.resolve(this.config.tokenRef);
  }

  validateRequest(request: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!request.job) errors.push("job is required");
    if (!this.config.baseUrl) errors.push("Jenkins baseUrl not configured");
    if (!this.config.tokenRef && !this.config.usernameRef) errors.push("Jenkins credentials not configured");
    return { valid: errors.length === 0, errors };
  }

  async trigger(request: any): Promise<{ externalRunId: string }> {
    const validation = this.validateRequest(request);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    throw new Error("Jenkins execution not available in this environment (no live network integration)");
  }

  async getStatus(externalRunId: string): Promise<{ status: string; logs?: string; evidence?: any }> {
    throw new Error("Jenkins status not available in this environment");
  }

  async cancel(externalRunId: string): Promise<void> {
    throw new Error("Jenkins cancellation not available in this environment");
  }
}
