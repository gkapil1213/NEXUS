import { ExecutionStore } from "./execution-store";
import { ApprovalRequest } from "./execution-models";

export class ApprovalGate {
  constructor(private store: ExecutionStore) {}

  evaluate(
    deploymentId: string,
    releaseId: string,
    environment: string,
    action: string
  ): "AUTOMATIC" | "HUMAN_APPROVAL_REQUIRED" | "DENIED" | "BLOCKED" {
    // Simple policy: production rollback requires human approval; production deploy requires human approval
    if (environment === "production") {
      return "HUMAN_APPROVAL_REQUIRED";
    }
    // staging or dev: automatic
    return "AUTOMATIC";
  }

  recordApproval(approval: ApprovalRequest): void {
    this.store.addApproval(approval);
  }

  updateApproval(approval: ApprovalRequest): void {
    this.store.updateApproval(approval);
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.store.getApproval(approvalId);
  }
}
