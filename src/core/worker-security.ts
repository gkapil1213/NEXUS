export interface WorkerSecurityPolicy {
  allowedOperations: string[];
  allowedExecutables: string[];
  allowedCwd?: string;
}

export class WorkerSecurity {
  constructor(private policy: WorkerSecurityPolicy) {}

  validateOperation(operation: string): boolean {
    return this.policy.allowedOperations.includes(operation);
  }

  validateExecutable(executable: string): boolean {
    return this.policy.allowedExecutables.includes(executable);
  }

  validateArgs(args: string[] | undefined): boolean {
    if (!args) return true;
    return args.every((arg) => !/[;&|`$(){}]/.test(arg));
  }

  validateCwd(cwd: string | undefined): boolean {
    if (!cwd) return true;
    if (cwd.includes("..")) return false;
    if (this.policy.allowedCwd && !cwd.startsWith(this.policy.allowedCwd)) return false;
    return true;
  }

  validateRequest(request: { operation: string; executable?: string; args?: string[]; cwd?: string }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!this.validateOperation(request.operation)) errors.push("Operation not allowed");
    if (request.executable && !this.validateExecutable(request.executable)) errors.push("Executable not allowed");
    if (!this.validateArgs(request.args)) errors.push("Invalid arguments");
    if (!this.validateCwd(request.cwd)) errors.push("Invalid working directory");
    return { valid: errors.length === 0, errors };
  }
}
