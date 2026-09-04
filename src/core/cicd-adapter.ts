import { ExecutionAdapter, ExecutionAdapterRequest, ExecutionAdapterResult } from "./execution-adapter";

export interface CICDProvider {
  trigger(request: ExecutionAdapterRequest): Promise<{ externalId: string }>;
  getStatus(externalId: string): Promise<{ status: string; logs?: string }>;
  cancel(externalId: string): Promise<void>;
}

export class CICDAdapter implements ExecutionAdapter {
  constructor(private provider: CICDProvider, private providerName: string = "generic-ci") {}

  getId(): string {
    return `cicd-${this.providerName}`;
  }

  getType(): string {
    return "cicd";
  }

  getCapabilities(): string[] {
    return ["ci.trigger", "ci.status", "ci.cancel"];
  }

  validate(request: ExecutionAdapterRequest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!request.operation || !["ci.trigger", "ci.status", "ci.cancel"].includes(request.operation)) {
      errors.push(`Unsupported CI operation: ${request.operation}`);
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(request: ExecutionAdapterRequest): Promise<ExecutionAdapterResult> {
    const validation = this.validate(request);
    if (!validation.valid) {
      return { success: false, stderr: validation.errors.join("; ") };
    }
    try {
      switch (request.operation) {
        case "ci.trigger": {
          const { externalId } = await this.provider.trigger(request);
          return { success: true, externalId, evidence: { provider: this.providerName } };
        }
        case "ci.status": {
          const externalId = request.args?.[0];
          if (!externalId) return { success: false, stderr: "Missing externalId" };
          const status = await this.provider.getStatus(externalId);
          return { success: true, stdout: JSON.stringify(status), evidence: { provider: this.providerName } };
        }
        case "ci.cancel": {
          const externalId = request.args?.[0];
          if (!externalId) return { success: false, stderr: "Missing externalId" };
          await this.provider.cancel(externalId);
          return { success: true, evidence: { provider: this.providerName } };
        }
        default:
          return { success: false, stderr: "Unsupported operation" };
      }
    } catch (err: any) {
      return { success: false, stderr: err?.message || String(err) };
    }
  }

  async cancel(executionId?: string): Promise<void> {
    if (executionId) {
      await this.provider.cancel(executionId);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
