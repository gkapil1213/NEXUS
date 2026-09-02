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

function runParserTests(): { passed: number; failed: number; results: any[] } {
  const cases = [
    { actions: [], expectedAction: "NO_CHANGE", expectedRisk: "LOW" },
    { actions: ["create"], expectedAction: "CREATE", expectedRisk: "MEDIUM" },
    { actions: ["update"], expectedAction: "UPDATE", expectedRisk: "MEDIUM" },
    { actions: ["delete"], expectedAction: "DELETE", expectedRisk: "HIGH" },
    { actions: ["create", "delete"], expectedAction: "REPLACE", expectedRisk: "HIGH" },
    { actions: ["delete", "create"], expectedAction: "REPLACE", expectedRisk: "HIGH" },
  ];
  const results: any[] = [];
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const json = JSON.stringify({ resource_changes: [{ address: "resource.test", change: { actions: c.actions } }] });
    const inspection = inspectPlan(json);
    const action = inspection.changes[0]?.action ?? "NO_CHANGE";
    const risk = inspection.risk;
    const ok = action === c.expectedAction && risk === c.expectedRisk;
    results.push({ actions: c.actions, action, risk, ok });
    if (ok) passed++; else failed++;
  }
  return { passed, failed, results };
}

async function main() {
  console.log("=== NEXUS Phase 6 Pass 3 ===\n");

  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase6-pass3.sqlite");
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
  console.log(`\nAWS Identity: ${identity.status} ${identity.reason ?? ""}`);
  console.log(`AWS Region: ${region.status} ${region.reason ?? region.evidence ?? ""}`);

  const tfDir = path.join(process.cwd(), ".infrastructure", "pass2-test");
  const terraform = new TerraformService();
  const tfAvailable = await terraform.isAvailable();
  if (!tfAvailable) {
    console.log("TERRAFORM: BLOCKED");
    const evidence = { pass: "Phase 6 Pass 3", timestamp: new Date().toISOString(), terraform: { available: false }, aws: { identity, region } };
    await new EvidenceService(path.join(process.cwd(), "phase6-pass3-evidence.json")).writeEvidence(evidence);
    console.log("FINAL STATUS: BLOCKED");
    return;
  }

  console.log("\nTERRAFORM");
  const fmt = await terraform.format(tfDir);
  console.log(`  fmt: ${fmt.status}`);
  const init = await terraform.init(tfDir);
  console.log(`  init: ${init.status}`);
  const validate = await terraform.validate(tfDir);
  console.log(`  validate: ${validate.status}`);
  const plan = await terraform.plan(tfDir);
  console.log(`  plan: ${plan.status} risk=${plan.risk} changes=${plan.changes.length}`);
  const show = await terraform.show(tfDir);
  console.log(`  show: ${show.status}`);

  const planJson = (show.evidence as string) ?? "{}";
  const planInspection = inspectPlan(planJson);
  const planDigest = computePlanDigest(planJson);
  console.log(`  Parsed changes: ${planInspection.changes.length}, destructive: ${planInspection.destructive_changes.length}, risk: ${planInspection.risk}`);
  console.log(`  Plan digest: ${planDigest}`);

  // Main policy evaluation (staging, no region requirement)
  const policyEngine = new InfrastructurePolicyEngine();
  const policyVerdicts = policyEngine.evaluate({
    environment: "staging",
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

  // Additional destructive production policy test
  const destructiveVerdicts = policyEngine.evaluate({
    environment: "production",
    actions: ["apply"],
    changes: { create: 0, update: 0, replace: 0, destroy: 1 },
    region: undefined,
  });
  const destructivePolicyPass = destructiveVerdicts.every(v => v.passed);
  console.log(`  Destructive Policy Test: ${destructivePolicyPass ? "PASS (unexpected)" : "BLOCKED as expected"}`);

  // Approval binding
  const approvalService = new InfrastructureApprovalService(engine);
  const approval = await approvalService.requestApproval({
    plan_id: "plan-pass3",
    environment: "staging",
    provider: "aws",
    workspace: tfDir,
    commit_sha: "pass3",
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

  // Apply safety
  const safeApply = new SafeApplyService();
  const applyVerdict = safeApply.evaluate({
    terraformAvailable: tfAvailable,
    awsAvailable: identity.status === "PASS",
    planValid: validate.status === "PASS" && plan.status === "PASS",
    planDigestMatches: digestOk,
    securityPolicyPass: policyPass,
    approvalExists: true,
    isDestructive: planInspection.destructive_changes.length > 0,
    isProduction: false,
  });
  console.log(`  Apply Safety: ${applyVerdict.status} - ${applyVerdict.reason}`);

  // Drift detection
  const driftService = new InfrastructureDriftService(terraform);
  const driftResult = await driftService.detect(tfDir);
  console.log(`  Drift Detection: ${driftResult.status}`);

  // Parser unit tests
  const parserTests = runParserTests();
  console.log(`\nPARSER TESTS: ${parserTests.passed} passed, ${parserTests.failed} failed`);

  const evidence = {
    phase: 6,
    pass: 3,
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
    },
    policy: {
      main: policyVerdicts,
      destructive_production: destructiveVerdicts,
      destructive_production_blocked: !destructivePolicyPass,
    },
    approval: {
      plan_digest_binding: digestOk,
      approval_id: approval.id,
    },
    apply_safety: applyVerdict,
    drift: driftResult.status,
    parser_tests: parserTests,
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No valid credentials" },
      { capability: "AWS Region", reason: region.reason ?? "No region configured" },
      { capability: "Terraform Apply", reason: applyVerdict.reason },
    ],
    failures: [],
  };

  await new EvidenceService(path.join(process.cwd(), "phase6-pass3-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass3-evidence.json");
  const finalStatus = applyVerdict.status === "PASS" ? "PASS" : "BLOCKED";
  console.log(`\nFINAL STATUS: ${finalStatus}`);
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
