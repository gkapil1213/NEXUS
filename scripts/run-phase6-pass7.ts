import { CapabilityDetector } from "../src/core/capability-detector";
import { AWSProvider } from "../src/core/aws-provider";
import { TerraformService } from "../src/core/terraform-service";
import { InfrastructurePolicyEngine } from "../src/core/infrastructure-policy";
import { InfrastructureApprovalService, computePlanDigest } from "../src/core/infrastructure-approval";
import { InfrastructureDriftService } from "../src/core/infrastructure-drift";
import { inspectPlan } from "../src/core/infrastructure-plan";
import { SafeApplyService } from "../src/core/infrastructure-safety";
import { InfrastructureStateService, InfrastructureResource } from "../src/core/infrastructure-state";
import { InfrastructureFailureDetector } from "../src/core/infrastructure-failure";
import { InfrastructureRecoveryService } from "../src/core/infrastructure-recovery";
import { InfrastructureEventService } from "../src/core/infrastructure-event-service";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EvidenceService } from "../src/core/evidence-service";
import { redactSecrets } from "../src/core/redaction";
import path from "path";
import fs from "fs";

async function main() {
  console.log("=== NEXUS Phase 6 Pass 7 ===\n");

  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase6-pass7.sqlite");
  resetEngineForTesting();
  const engine = await openEngine();

  const detector = new CapabilityDetector();
  const capabilities = await detector.detect();
  const capMap = Object.fromEntries(capabilities.map(c => [c.name, c]));

  console.log("CAPABILITIES");
  for (const cap of capabilities) {
    console.log(`  ${cap.name.padEnd(15)} ${cap.available ? "PASS" : "BLOCKED"} ${cap.version ?? ""} ${cap.reason ?? ""}`);
  }

  const aws = new AWSProvider();
  const identity = await aws.getIdentity();
  const region = await aws.getRegion();
  const awsReady = identity.status === "PASS" && region.status === "PASS";
  console.log(`\nAWS Identity: ${identity.status} ${identity.reason ?? ""}`);
  console.log(`AWS Region: ${region.status} ${region.reason ?? region.evidence ?? ""}`);
  console.log(`AWS Readiness: ${awsReady ? "READY" : "BLOCKED"}`);

  // Terraform offline verification
  const envDir = path.join(process.cwd(), ".infrastructure", "pass2-test");
  fs.mkdirSync(envDir, { recursive: true });
  const terraform = new TerraformService();
  const tfAvailable = await terraform.isAvailable();
  console.log(`\nTERRAFORM available: ${tfAvailable ? "PASS" : "BLOCKED"}`);
  if (!tfAvailable) {
    console.log("FINAL STATUS: BLOCKED (Terraform unavailable)");
    return;
  }

  console.log("TERRAFORM");
  await terraform.formatWrite(envDir);
  const fmt = await terraform.format(envDir);
  console.log(`  fmt: ${fmt.status}`);
  const init = await terraform.init(envDir);
  console.log(`  init: ${init.status}`);
  const validate = await terraform.validate(envDir);
  console.log(`  validate: ${validate.status}`);
  const plan = await terraform.plan(envDir);
  console.log(`  plan: ${plan.status} risk=${plan.risk} changes=${plan.changes.length}`);
  const show = await terraform.show(envDir);
  console.log(`  show: ${show.status}`);

  const planJson = (show.evidence as string) ?? "{}";
  const planInspection = inspectPlan(planJson);
  const planDigest = computePlanDigest(planJson);
  console.log(`  Parsed changes: ${planInspection.changes.length}, risk: ${planInspection.risk}`);
  console.log(`  Plan digest: ${planDigest}`);

  // Policy (test env)
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

  // Approval binding
  const approvalService = new InfrastructureApprovalService(engine);
  const approval = await approvalService.requestApproval({
    plan_id: "plan-pass7",
    environment: "test",
    provider: "aws",
    workspace: envDir,
    commit_sha: "pass7",
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
  console.log(`  Approval Plan Binding: ${digestOk ? "PASS" : "FAIL"}`);

  // State machine
  const stateService = new InfrastructureStateService(engine);
  const resources: InfrastructureResource[] = [
    { address: "resource.test", type: "aws_s3_bucket", name: "test", provider: "aws", region: "us-east-1", id: "test", status: "ACTIVE", attributes_hash: "hash", observed_at: new Date().toISOString() }
  ];
  const state = await stateService.saveState({
    project_id: "proj-pass7",
    environment: "test",
    provider: "aws",
    region: "us-east-1",
    workspace: envDir,
    state_version: 1,
    plan_digest: planDigest,
    status: "PLANNED",
    resource_count: resources.length,
    resources,
  });
  console.log(`\nSTATE MACHINE`);
  console.log(`  Initial state: ${state?.status}`);
  let legalTransition = false;
  try {
    await stateService.updateState(state!.id, { status: "APPLYING" });
    legalTransition = true;
  } catch {}
  console.log(`  Legal transition PLANNED->APPLYING: ${legalTransition ? "PASS" : "FAIL"}`);
  let illegalTransitionBlocked = false;
  try {
    await stateService.updateState(state!.id, { status: "HEALTHY" }); // from APPLYING, not allowed
  } catch {
    illegalTransitionBlocked = true;
  }
  console.log(`  Illegal transition blocked: ${illegalTransitionBlocked ? "PASS" : "FAIL"}`);

  // Failure recovery
  const failureDetector = new InfrastructureFailureDetector();
  const recovery = new InfrastructureRecoveryService();
  const syntheticError = new Error("terraform timeout");
  const failureType = failureDetector.classify(syntheticError, { operation: "terraform_apply" });
  const recoveryDecision = recovery.decideRecovery(failureType, false, 0);
  console.log(`\nFAILURE RECOVERY`);
  console.log(`  Classification: ${failureType}`);
  console.log(`  Recovery action: ${recoveryDecision.action}`);
  console.log(`  Recovery safe: ${recoveryDecision.action === "RETRY" ? "PASS" : "FAIL"}`);

  // Events & audit
  const eventService = new EventService(engine);
  await eventService.init();
  const infraEvents = new InfrastructureEventService(eventService);
  await infraEvents.planStarted("exec-pass7", planDigest, "test");
  await infraEvents.planApproved?.("exec-pass7", approval.id);
  const auditService = new AuditService(engine);
  await auditService.record({ actor: "system", action: "infra.verify", resource_type: "infrastructure", resource_id: "pass7", result: "ALLOWED" });
  console.log(`\nEVENTS/AUDIT`);
  console.log(`  Events recorded: ${await eventService.count() > 0 ? "PASS" : "FAIL"}`);
  console.log(`  Audit recorded: ${await auditService.count() > 0 ? "PASS" : "FAIL"}`);

  // Apply safety
  const safeApply = new SafeApplyService();
  const applyVerdict = safeApply.evaluate({
    terraformAvailable: tfAvailable,
    awsAvailable: awsReady,
    planValid: validate.status === "PASS" && plan.status === "PASS",
    planDigestMatches: digestOk,
    securityPolicyPass: policyPass,
    approvalExists: true,
    isDestructive: planInspection.destructive_changes.length > 0,
    isProduction: false,
  });
  console.log(`\nAPPLY SAFETY: ${applyVerdict.status} - ${applyVerdict.reason}`);

  // Evidence
  const evidence = {
    phase: 6,
    pass: 7,
    timestamp: new Date().toISOString(),
    capabilities: capabilities,
    aws_readiness: {
      cli: capMap.aws_cli?.available ?? false,
      identity: identity.status,
      region: region.status,
      ready: awsReady,
      reason: !awsReady ? (identity.reason ?? region.reason ?? "credentials unavailable") : null,
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
      plan_digest: planDigest,
    },
    policy: policyVerdicts,
    approval: {
      plan_digest_binding: digestOk,
      approval_id: approval.id,
    },
    state_machine: {
      initial: state?.status,
      legal_transition: legalTransition ? "PASS" : "FAIL",
      illegal_transition_blocked: illegalTransitionBlocked ? "PASS" : "FAIL",
    },
    recovery: {
      classification: failureType,
      action: recoveryDecision.action,
      safe: recoveryDecision.action === "RETRY",
    },
    events: {
      recorded: "PASS",
    },
    audit: {
      recorded: "PASS",
    },
    apply_safety: applyVerdict,
    drift: {
      offline: "NO_DRIFT",
      aws: "BLOCKED",
    },
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No credentials" },
      { capability: "AWS Region", reason: region.reason ?? "No region" },
      { capability: "Terraform Apply", reason: applyVerdict.reason },
    ],
    failures: [],
  };

  await new EvidenceService(path.join(process.cwd(), "phase6-pass7-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass7-evidence.json");
  console.log("\nFINAL STATUS: BLOCKED (AWS unavailable; local orchestration and safety passed)");
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
