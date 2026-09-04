import { ExecutionAdapter } from "./execution-adapter";
import { ExecutionAdapterRegistry } from "./execution-adapter-registry";

export interface ExecutionRequest {
  adapterId: string;
  operation: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  repo?: string;
  ref?: string;
  environment?: string;
}

export class ExecutionRequestValidator {
  constructor(private registry: ExecutionAdapterRegistry) {}

  validate(request: ExecutionRequest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const adapter = this.registry.get(request.adapterId);
    if (!adapter) {
      errors.push(`Adapter ${request.adapterId} not found or disabled`);
      return { valid: false, errors };
    }
    if (!adapter.getCapabilities().includes(request.operation)) {
      errors.push(`Operation ${request.operation} not in adapter capabilities`);
    }
    const adapterValidation = adapter.validate({ operation: request.operation, args: request.args, cwd: request.cwd, env: request.env, timeoutMs: request.timeoutMs });
    if (!adapterValidation.valid) {
      errors.push(...adapterValidation.errors);
    }
    if (request.environment === "production" && !["ci.trigger", "ci.status"].includes(request.operation)) {
      errors.push("Direct local operation in production is not allowed without explicit approval");
    }
    if (request.args) {
      for (const arg of request.args) {
        if (arg.includes("&&") || arg.includes("||") || arg.includes(";") || arg.includes("$(") || arg.includes("`")) {
          errors.push("Shell metacharacters detected in arguments");
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }
}
