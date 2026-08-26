import { ReleaseService } from "../src/core/release-service.ts";
import { ApprovalService } from "../src/core/approval-service.ts";

(async () => {
  const releaseService = new ReleaseService();
  const approvalService = new ApprovalService();

  const commitSha = "cccccccccccccccccccccccccccccccccccccccc";
  const artifactDigest = "sha256:testdigest123456";

  // Create a draft release
  const draft = await releaseService.createDraft("1.0.0", commitSha, "staging", {
    artifact_digest: artifactDigest,
  });
  console.log("Created draft release:", draft.release_id, draft.status);

  // Move to SECURITY_REVIEW
  const secReview = await releaseService.transition(draft.release_id, "SECURITY_REVIEW");
  console.log("Release status:", secReview.status);

  // Move to READY_FOR_APPROVAL
  const ready = await releaseService.transition(draft.release_id, "READY_FOR_APPROVAL");
  console.log("Release status:", ready.status);

  // Record approval
  const approval = await approvalService.recordApproval({
    release_id: ready.release_id,
    artifact_digest: artifactDigest,
    environment: "staging",
    approver: "test-user",
    decision: "APPROVED",
    reason: "All checks passed",
  });
  console.log("Approval recorded:", approval.approval_id, approval.decision);

  // Move to APPROVED (requires manual transition in this simple model)
  const approved = await releaseService.transition(ready.release_id, "APPROVED");
  console.log("Release status:", approved.status);

  // Move to DEPLOYING then VERIFIED
  const deploying = await releaseService.transition(approved.release_id, "DEPLOYING");
  console.log("Release status:", deploying.status);
  const verified = await releaseService.transition(deploying.release_id, "VERIFIED");
  console.log("Release status:", verified.status);

  console.log("\nRelease flow test passed!");
  process.exit(0);
})();