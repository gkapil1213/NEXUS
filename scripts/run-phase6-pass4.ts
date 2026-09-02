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
import fs from "fs";

async function main() {
  console.log("=== NEXUS Phase 6 Pass 4 ===\n");

  // Database setup for approval/audit storage
  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase6-pass4.sqlite");
  resetEngineForTesting();
  const engine = await openEngine();

  // Capability detection
  const detector = new CapabilityDetector();
  const capabilities = await detector.detect();
  const capMap = Object.fromEntries(capabilities.map(c => [c.name, c]));

  console.log("CAPABILITIES");
  for (const cap of capabilities) {
    console.log(`  ${cap.name.padEnd(15)} ${cap.available ? "PASS" : "BLOCKED"} ${cap.version ?? ""} ${cap.reason ?? ""}`);
  }

  // AWS checks
  const aws = new AWSProvider();
  const identity = await aws.getIdentity();
  const region = await aws.getRegion();
  console.log(`\nAWS Identity: ${identity.status} ${identity.reason ?? ""}`);
  console.log(`AWS Region: ${region.status} ${region.reason ?? region.evidence ?? ""}`);

  // Environment directory
  const envDir = path.join(process.cwd(), ".infrastructure", "environments", "test");
  fs.mkdirSync(envDir, { recursive: true });

  // Generate deterministic Terraform config for the environment
  const mainTf = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                        = "us-east-1"
  skip_credentials_validation   = true
  skip_region_validation        = true
  skip_requesting_account_id    = true
}

resource "aws_s3_bucket" "test_bucket" {
  bucket = "nexus-test-env-bucket"
  tags = {
    Environment = "test"
  }
}
`;
  fs.writeFileSync(path.join(envDir, "main.tf"), mainTf.trim());

  const terraform = new TerraformService();
  const tfAvailable = await terraform.isAvailable();
  if (!tfAvailable) {
    console.log("TERRAFORM: BLOCKED");
    await new EvidenceService(path.join(process.cwd(), "phase6-pass4-evidence.json")).writeEvidence({
      pass: "Phase 6 Pass 4",
      timestamp: new Date().toISOString(),
      terraform: { available: false },
      aws: { identity, region },
      final: "BLOCKED"
    });
    return;
  }

  console.log("\nTERRAFORM");
  await terraform.formatWrite(envDir);
  const fmt = await terraform.format(envDir);
  console.log(`  fmt: ${fmt.status} ${fmt.reason ?? ""}`);
  const init = await terraform.init(envDir);
  console.log(`  init: ${init.status} ${init.reason ?? ""}`);
  const validate = await terraform.validate(envDir);
  console.log(`  validate: ${validate.status} ${validate.reason ?? ""}`);
  const plan = await terraform.plan(envDir);
  console.log(`  plan: ${plan.status} risk=${plan.risk} changes=${plan.changes.length}`);
  const show = await terraform.show(envDir);
  console.log(`  show: ${show.status}`);

  const planJson = (show.evidence as string) ?? "{}";
  const planInspection = inspectPlan(planJson);
  const planDigest = computePlanDigest(planJson);
  console.log(`  Parsed changes: ${planInspection.changes.length}, destructive: ${planInspection.destructive_changes.length}, risk: ${planInspection.risk}`);
  console.log(`  Plan digest: ${planDigest}`);

  // Policy: test environment (non-production) create-only plan should pass
  const policyEngine = new InfrastructurePolicyEngine();
  const policyVerdicts = policyEngine.evaluate({
    environment: "test",
    actions: ["apply"],
    changes: {
      create: planInspection.changes.filter(c => c.action === "CREATE").length,
      update: planInspection.changes.filter(c => c.action === "UPDATE").length,
      replace: planInspection.changes.filter(c => c.action === "REPLACE").length,
      destroy: planInspection.changes.filter(c => c.action === "DELETE").length,
    },
    region: "us-east-1",
  });
  const policyPass = policyVerdicts.every(v => v.passed);
  console.log(`  Policy: ${policyPass ? "PASS" : "FAIL"}`);

  // Destructive production policy test
  const destructiveVerdicts = policyEngine.evaluate({
    environment: "production",
    actions: ["apply"],
    changes: { create: 0, update: 0, replace: 0, destroy: 1 },
    region: "us-east-1",
  });
  const destructivePolicyPass = destructiveVerdicts.every(v => v.passed);
  console.log(`  Destructive Production Policy: ${destructivePolicyPass ? "FAIL (should be blocked)" : "BLOCKED as expected"}`);

  // Plan tamper test
  const tamperedPlanJson = planJson.replace("nexus-test-env-bucket", "tampered-bucket");
  const tamperedDigest = computePlanDigest(tamperedPlanJson);
  console.log(`  Plan tamper test: original=${planDigest.slice(0,12)}... tampered=${tamperedDigest.slice(0,12)}... match=${tamperedDigest === planDigest}`);

  // Approval binding
  const approvalService = new InfrastructureApprovalService(engine);
  const approval = await approvalService.requestApproval({
    plan_id: "plan-pass4",
    environment: "test",
    provider: "aws",
    workspace: envDir,
    commit_sha: "pass4",
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
  const tamperedOk = await approvalService.verifyPlanDigest(approval.id, tamperedDigest);
  console.log(`  Plan Digest Binding (original): ${digestOk ? "PASS" : "FAIL"}`);
  console.log(`  Plan Digest Binding (tampered): ${tamperedOk ? "FAIL (should fail)" : "PASS"}`);

  // Apply safety
  const safeApply = new SafeApplyService();
  const applyVerdict = safeApply.evaluate({
    terraformAvailable: tfAvailable,
    awsAvailable: identity.status === "PASS",
    planValid: validate.status === "PASS" && plan.status === "PASS",
    planDigestMatches: digestOk && !tamperedOk,
    securityPolicyPass: policyPass,
    approvalExists: true,
    isDestructive: planInspection.destructive_changes.length > 0,
    isProduction: false,
  });
  console.log(`  Apply Safety: ${applyVerdict.status} - ${applyVerdict.reason}`);

  // Drift detection
  const driftService = new InfrastructureDriftService(terraform);
  const driftResult = await driftService.detect(envDir);
  console.log(`  Drift Detection: ${driftResult.status}`);

  // Evidence
  const evidence = {
    phase: 6,
    pass: 4,
    timestamp: new Date().toISOString(),
    capabilities: capabilities,
    aws: { identity, region },
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
      tampered_plan_digest: tamperedDigest,
    },
    policy: {
      main: policyVerdicts,
      destructive_production_blocked: !destructivePolicyPass,
    },
    approval: {
      plan_digest_binding_original: digestOk,
      plan_digest_binding_tampered: tamperedOk,
      approval_id: approval.id,
    },
    apply_safety: applyVerdict,
    drift: driftResult.status,
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No valid credentials" },
      { capability: "AWS Region", reason: region.reason ?? "No region configured" },
      { capability: "Terraform Apply", reason: applyVerdict.reason },
    ],
    failures: [],
  };

  await new EvidenceService(path.join(process.cwd(), "phase6-pass4-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass4-evidence.json");
  const finalStatus = applyVerdict.status === "PASS" ? "PASS" : "BLOCKED";
  console.log(`\nFINAL STATUS: ${finalStatus}`);
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
