import { ExecutionAdapter, ExecutionAdapterRequest, ExecutionAdapterResult, ExecutionAdapterContext } from "./execution-adapter";

export class SkippedEnvironmentExecutionAdapter implements ExecutionAdapter {
  getId(): string { return "skipped-env"; }
  getType(): string { return "local"; }
  getCapabilities(): string[] { return ["skipped-environment"]; }
  validate(_request: ExecutionAdapterRequest): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }
  async execute(_request: ExecutionAdapterRequest, _context?: ExecutionAdapterContext): Promise<ExecutionAdapterResult> {
    return { success: false, evidence: { status: "SKIPPED_ENVIRONMENT" }, stderr: "Local execution unavailable in this environment" };
  }
  async cancel(_executionId?: string): Promise<void> {}
  async healthCheck(): Promise<boolean> { return false; }
}
