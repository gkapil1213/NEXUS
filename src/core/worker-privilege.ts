export type PrivilegeLevel = "STANDARD" | "PRIVILEGED" | "RESTRICTED";

export interface PrivilegeRequest {
  operation: string;
  level: PrivilegeLevel;
}

export class WorkerPrivilegeService {
  constructor(private allowedPrivilegedOperations: string[] = []) {}

  isPrivileged(operation: string): boolean {
    return this.allowedPrivilegedOperations.includes(operation);
  }

  authorize(request: PrivilegeRequest): boolean {
    if (request.level === "PRIVILEGED") {
      return this.isPrivileged(request.operation);
    }
    return true;
  }
}
