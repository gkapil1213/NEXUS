import { CICDProvider, CICDStatusContext } from "./cicd-provider";
import { CICDProviderRegistry } from "./cicd-provider-registry";

export class CICDRunManager {
  constructor(private registry: CICDProviderRegistry) {}

  async trigger(providerId: string, request: any): Promise<{ externalRunId: string }> {
    const provider = this.registry.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found or disabled`);
    const validation = provider.validateRequest(request);
    if (!validation.valid) {
      throw new Error(`Invalid request: ${validation.errors.join("; ")}`);
    }
    return provider.trigger(request);
  }

  async getStatus(providerId: string, externalRunId: string, ctx?: CICDStatusContext): Promise<{ status: string; logs?: string; evidence?: any }> {
    const provider = this.registry.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found or disabled`);
    return provider.getStatus(externalRunId, ctx);
  }

  async cancel(providerId: string, externalRunId: string, ctx?: CICDStatusContext): Promise<void> {
    const provider = this.registry.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found or disabled`);
    await provider.cancel(externalRunId, ctx);
  }
}
