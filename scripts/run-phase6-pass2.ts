import { CapabilityDetector } from "../src/core/capability-detector";
import { AWSProvider } from "../src/core/aws-provider";
import { TerraformService } from "../src/core/terraform-service";
import { InfrastructurePolicyEngine } from "../src/core/infrastructure-policy";
import { InfrastructureApprovalService, computePlanDigest } from "../src/core/infrastructure-approval";
import { InfrastructureDriftService } from "../src/core/infrastructure-drift";
import { inspectPlan } from "../src/core/infrastructure-plan";
import { SafeApplyService } from "../src/core/infrastructure-safety";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EvidenceService } from "../src/core/evidence-service";
import { redactSecrets } from "../src/core/redaction";
import path from "path";

async function main() {
  console.log("=== NEXUS Phase 6 Pass 2 ===\n");

  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase6-pass2.sqlite");
  resetEngineForTesting();
  const engine = await openEngine();

  const detector = new CapabilityDetector();
  const capabilities = await detector.detect();
  const capMap = Object.fromEntries(capabilities.map(c => [c.name, c]));

  console.log("CAPABILITIES");
  console.log(`  node: ${capMap.node?.available ? "PASS" : "BLOCKED"} ${capMap.node?.version ?? ""}`);
  console.log(`  npm: ${capMap.npm?.available ? "PASS" : "BLOCKED"} ${capMap.npm?.version ?? ""}`);
  console.log(`  docker_cli: ${capMap.docker_cli?.available ? "PASS" : "BLOCKED"} ${capMap.docker_cli?.version ?? ""}`);
  console.log(`  docker_daemon: ${capMap.docker_daemon?.available ? "PASS" : "BLOCKED"} ${capMap.docker_daemon?.reason ?? ""}`);
  console.log(`  terraform: ${capMap.terraform?.available ? "PASS" : "BLOCKED"} ${capMap.terraform?.version ?? ""}`);
  console.log(`  aws: ${capMap.aws_cli?.available ? "PASS" : "BLOCKED"} ${capMap.aws_cli?.version ?? ""}`);

  const aws = new AWSProvider();
  const identity = await aws.getIdentity();
  const region = await aws.getRegion();
  console.log(`\nAWS Identity: ${identity.status} ${identity.reason ?? ""}`);
  console.log(`AWS Region: ${region.status} ${region.reason ?? region.evidence ?? ""}`);

  const tfDir = path.join(process.cwd(), ".infrastructure", "pass2-test");
  const terraform = new TerraformService();
  const tfAvailable = await terraform.isAvailable();

  if (!tfAvailable) {
    console.log("TERRAFORM: BLOCKED (not available)");
    await new EvidenceService(path.join(process.cwd(), "phase6-pass2-evidence.json")).writeEvidence({
      pass: "Phase 6 Pass 2",
      timestamp: new Date().toISOString(),
      terraform: { available: false },
      aws: { identity, region },
      final: "BLOCKED"
    });
    return;
  }

  console.log("\nTERRAFORM");
  const fmt = await terraform.format(tfDir);
  console.log(`  fmt: ${fmt.status} ${fmt.reason ?? ""}`);
  const init = await terraform.init(tfDir);
  console.log(`  init: ${init.status} ${init.reason ?? ""}`);
  const validate = await terraform.validate(tfDir);
  console.log(`  validate: ${validate.status} ${validate.reason ?? ""}`);
  const plan = await terraform.plan(tfDir);
  console.log(`  plan: ${plan.status} risk=${plan.risk} changes=${plan.changes.length}`);
  const show = await terraform.show(tfDir);
  console.log(`  show: ${show.status}`);

  const planJson = (show.evidence as string) ?? "{}";
  const planInspection = inspectPlan(planJson);
  const planDigest = computePlanDigest(planJson);
  console.log(`  Parsed changes: ${planInspection.changes.length}, destructive: ${planInspection.destructive_changes.length}, risk: ${planInspection.risk}`);

  const policyEngine = new InfrastructurePolicyEngine();
  const policyVerdicts = policyEngine.evaluate({
    environment: "production",
    actions: ["apply"],
    changes: {
      create: planInspection.changes.filter(c => c.action === "CREATE").length,
      update: planInspection.changes.filter(c => c.action === "UPDATE").length,
      replace: planInspection.changes.filter(c => c.action === "REPLACE").length,
      destroy: planInspection.changes.filter(c => c.action === "DELETE").length,
    },
    region: (region.evidence as string) ?? undefined,
  });
  const policyPass = policyVerdicts.every(v => v.passed);
  console.log(`  Policy: ${policyPass ? "PASS" : "FAIL"}`);

  const approvalService = new InfrastructureApprovalService(engine);
  const approval = await approvalService.requestApproval({
    plan_id: "plan-pass2",
    environment: "production",
    provider: "aws",
    workspace: tfDir,
    commit_sha: "pass2",
    plan_digest: planDigest,
    requested_changes: {
      create: planInspection.changes.filter(c => c.action === "CREATE").length,
      update: planInspection.changes.filter(c => c.action === "UPDATE").length,
      replace: planInspection.changes.filter(c => c.action === "REPLACE").length,
      destroy: planInspection.changes.filter(c => c.action === "DELETE").length,
    },
    risk: planInspection.risk,
    approver: "human-required",
  });
  const digestOk = await approvalService.verifyPlanDigest(approval.id, planDigest);
  console.log(`  Plan Digest Binding: ${digestOk ? "PASS" : "FAIL"}`);

  const safeApply = new SafeApplyService();
  const applyVerdict = safeApply.evaluate({
    terraformAvailable: tfAvailable,
    awsAvailable: identity.status === "PASS",
    planValid: validate.status === "PASS" && plan.status === "PASS",
    planDigestMatches: digestOk,
    securityPolicyPass: policyPass,
    approvalExists: true,
    isDestructive: planInspection.destructive_changes.length > 0,
    isProduction: true,
  });
  console.log(`  Apply Safety: ${applyVerdict.status} - ${applyVerdict.reason}`);

  const driftService = new InfrastructureDriftService(terraform);
  const driftResult = await driftService.detect(tfDir);
  console.log(`  Drift Detection: ${driftResult.status}`);

  const evidence = {
    pass: "Phase 6 Pass 2",
    timestamp: new Date().toISOString(),
    capabilities: {
      node: capMap.node?.available ?? false,
      npm: capMap.npm?.available ?? false,
      docker_cli: capMap.docker_cli?.available ?? false,
      docker_daemon: capMap.docker_daemon?.available ?? false,
      terraform: tfAvailable,
      aws: capMap.aws_cli?.available ?? false,
    },
    terraform: {
      available: tfAvailable,
      fmt: fmt.status,
      init: init.status,
      validate: validate.status,
      plan: plan.status,
      show: show.status,
      risk: planInspection.risk,
      changes: planInspection.changes,
      destructive_changes: planInspection.destructive_changes,
      plan_digest: planDigest,
    },
    aws: { identity, region },
    policy: policyVerdicts,
    approval: {
      plan_digest_binding: digestOk,
      approval_id: approval.id,
    },
    apply_safety: applyVerdict,
    drift_detection: driftResult.status,
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No valid credentials" },
      { capability: "AWS Region", reason: region.reason ?? "No region configured" },
      { capability: "Terraform Apply", reason: applyVerdict.reason },
    ],
    failures: [],
  };

  await new EvidenceService(path.join(process.cwd(), "phase6-pass2-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass2-evidence.json");
  const finalStatus = applyVerdict.status === "PASS" ? "PASS" : "BLOCKED";
  console.log(`\nFINAL STATUS: ${finalStatus}`);
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
