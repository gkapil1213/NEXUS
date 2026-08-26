import { ApprovalService } from "../src/core/approval-service.ts";

(async () => {
  const releaseId = process.env.RELEASE_ID;
  const digest = process.env.ARTIFACT_DIGEST;
  if (!releaseId || !digest) {
    console.error("Set RELEASE_ID and ARTIFACT_DIGEST");
    process.exit(1);
  }
  const approvalService = new ApprovalService();
  await approvalService.recordApproval({
    release_id: releaseId,
    artifact_digest: digest,
    environment: "production",
    approver: "human-approver",
    decision: "APPROVED",
    reason: "Release gate approval",
  });
  console.log("Approval recorded");
})();