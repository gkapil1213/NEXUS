import { ApprovalService } from "../src/core/approval-service.ts";

(async () => {
  const approvalService = new ApprovalService();

  const releaseId = "rel_test_binding";
  const artifactDigestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const artifactDigestB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Record approval only for Artifact A
  await approvalService.recordApproval({
    release_id: releaseId,
    artifact_digest: artifactDigestA,
    environment: "production",
    approver: "human-approver",
    decision: "APPROVED",
    reason: "approve artifact A only",
  });

  const approvals = approvalService.listForRelease(releaseId);

  const isAAllowed = approvals.some(
    (a) => a.decision === "APPROVED" && a.artifact_digest === artifactDigestA,
  );
  const isBAllowed = approvals.some(
    (a) => a.decision === "APPROVED" && a.artifact_digest === artifactDigestB,
  );

  console.log("Approval A");
  console.log("     │");
  console.log(`     ├── Artifact A → ${isAAllowed ? "ALLOWED" : "BLOCKED"}`);
  console.log(`     └── Artifact B → ${isBAllowed ? "ALLOWED" : "BLOCKED"}`);

  if (isAAllowed && !isBAllowed) {
    console.log("\nApproval artifact binding test PASSED");
    process.exit(0);
  } else {
    console.error("\nApproval artifact binding test FAILED");
    process.exit(1);
  }
})();