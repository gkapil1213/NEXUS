import { ReleaseService } from "../src/core/release-service.ts";
import { ApprovalService } from "../src/core/approval-service.ts";

(async () => {
  const releaseService = new ReleaseService();
  const approvalService = new ApprovalService();

  // Create two releases
  const releaseA = await releaseService.createDraft("1.0.0", "commitA", "staging");
  const releaseB = await releaseService.createDraft("2.0.0", "commitB", "staging");

  // Record approval only for release A
  await approvalService.recordApproval({
    release_id: releaseA.release_id,
    artifact_digest: "sha256:aaaa",
    environment: "staging",
    approver: "test-user",
    decision: "APPROVED",
    reason: "testing",
  });

  // Check approvals for release A
  const approvalsA = approvalService.listForRelease(releaseA.release_id);
  const isAApproved = approvalsA.some((a) => a.decision === "APPROVED");

  // Check approvals for release B
  const approvalsB = approvalService.listForRelease(releaseB.release_id);
  const isBApproved = approvalsB.some((a) => a.decision === "APPROVED");

  console.log(`Release A approved: ${isAApproved}`);
  console.log(`Release B approved: ${isBApproved}`);

  if (!isAApproved) {
    console.error("Approval protection FAILED: release A should be approved");
    process.exit(1);
  }
  if (isBApproved) {
    console.error("Approval protection FAILED: release B should NOT be approved");
    process.exit(1);
  }

  console.log("Approval protection test PASSED: approval is bound to a specific release");
  process.exit(0);
})();