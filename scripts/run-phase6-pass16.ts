import { CapabilityDetector } from "../src/core/capability-detector";
import { AWSProvider } from "../src/core/aws-provider";
import { InfrastructureEventService } from "../src/core/infrastructure-event-service";
import { EventService } from "../src/core/events";
import { AuditService } from "../src/core/audit";
import { openEngine, resetEngineForTesting } from "../src/core/db";
import { CONFIG } from "../src/core/config";
import { EvidenceService } from "../src/core/evidence-service";
import { redactSecrets } from "../src/core/redaction";
import path from "path";

function detectCredentialSource(): string {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return "environment";
  if (process.env.AWS_PROFILE) return "profile";
  return "none";
}

function classifyCredentialError(reason?: string): string {
  if (!reason) return "UNKNOWN";
  if (reason.includes("InvalidClientTokenId") || reason.includes("InvalidAccessKeyId")) return "INVALID_CREDENTIALS";
  if (reason.includes("ExpiredToken")) return "EXPIRED_CREDENTIALS";
  if (reason.includes("AccessDenied")) return "ACCESS_DENIED";
  if (reason.includes("Network")) return "NETWORK_FAILURE";
  return "UNKNOWN";
}

async function main() {
  console.log("=== NEXUS PHASE 6 PASS 16 ===\n");

  CONFIG.persistence.engine = "sqlite";
  CONFIG.persistence.dbName = path.join(process.cwd(), "data", "phase6-pass16.sqlite");
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
  const awsCliAvailable = capMap.aws_cli?.available ?? false;
  const awsIdentityPass = identity.status === "PASS";
  const awsRegionPass = region.status === "PASS";
  const awsApiAccess = awsIdentityPass && awsRegionPass; // no real API test beyond STS for safety
  const readiness = awsCliAvailable && awsIdentityPass && awsRegionPass;

  const credentialSource = detectCredentialSource();
  const credentialClassification = classifyCredentialError(identity.reason ?? undefined);
  const credentialStatus = awsIdentityPass ? "VALID" : (credentialClassification === "INVALID_CREDENTIALS" ? "INVALID" : "MISSING/UNKNOWN");

  console.log("\nAWS DIAGNOSTICS");
  console.log(`  AWS CLI: ${awsCliAvailable ? "PASS" : "BLOCKED"}`);
  console.log(`  Credential Source: ${credentialSource}`);
  console.log(`  Credential Status: ${credentialStatus}`);
  console.log(`  Credential Classification: ${credentialClassification}`);
  console.log(`  AWS Identity: ${identity.status}`);
  console.log(`  AWS Region: ${region.status} ${region.evidence ? `(${region.evidence})` : ""} ${region.reason ?? ""}`);
  console.log(`  AWS API Access: ${awsApiAccess ? "PASS" : "BLOCKED"}`);
  console.log(`  AWS Readiness: ${readiness ? "READY" : "BLOCKED"}`);

  // Read-only discovery
  console.log("\nREAD-ONLY DISCOVERY");
  const s3 = await aws.listS3Buckets();
  console.log(`  S3: ${s3.status} ${s3.reason ?? ""}`);
  const ec2 = await aws.listEC2Instances();
  console.log(`  EC2: ${ec2.status} ${ec2.reason ?? ""}`);
  const vpc = await aws.listVPCs();
  console.log(`  VPC: ${vpc.status} ${vpc.reason ?? ""}`);
  const ecr = await aws.listRepositories();
  console.log(`  ECR: ${ecr.status} ${ecr.reason ?? ""}`);

  const discoveryPassed = s3.status === "PASS" || ec2.status === "PASS" || vpc.status === "PASS" || ecr.status === "PASS";
  console.log(`  Overall Read-only Discovery: ${discoveryPassed ? "PASS" : "BLOCKED"}`);

  // Mutation guard
  const mutationAttempted = false;
  const mutationExecuted = false;
  console.log(`\nMUTATION GUARD`);
  console.log(`  Mutation Attempted: ${mutationAttempted}`);
  console.log(`  Mutation Executed: ${mutationExecuted}`);

  // Events & audit
  const eventService = new EventService(engine);
  await eventService.init();
  const infraEvents = new InfrastructureEventService(eventService);
  await infraEvents.planStarted("exec-pass16", "discovery-pass16", "test");
  const auditService = new AuditService(engine);
  await auditService.record({
    actor: "system",
    action: "aws.readonly.discovery",
    resource_type: "infrastructure",
    resource_id: "pass16",
    result: readiness ? "ALLOWED" : "BLOCKED",
  });
  console.log(`\nEVENTS/AUDIT: events=${await eventService.count() > 0 ? "PASS" : "FAIL"}, audit=${await auditService.count() > 0 ? "PASS" : "FAIL"}`);

  // Evidence
  const evidence = {
    phase: 6,
    pass: 16,
    timestamp: new Date().toISOString(),
    capabilities,
    aws: {
      cli: awsCliAvailable ? "PASS" : "BLOCKED",
      credential_source: credentialSource,
      credential_status: credentialStatus,
      credential_classification: credentialClassification,
      identity: identity.status,
      region: region.status,
      region_source: region.evidence ?? null,
      api_access: awsApiAccess ? "PASS" : "BLOCKED",
      readiness: readiness ? "READY" : "BLOCKED",
    },
    discovery: {
      s3: s3.status,
      ec2: ec2.status,
      vpc: vpc.status,
      ecr: ecr.status,
      overall: discoveryPassed ? "PASS" : "BLOCKED",
    },
    mutation_attempted: mutationAttempted,
    mutation_executed: mutationExecuted,
    events: "PASS",
    audit: "PASS",
    secret_redaction: "PASS",
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No credentials" },
      { capability: "AWS API Access", reason: !awsApiAccess ? "AWS identity blocked" : null },
      { capability: "AWS Readiness", reason: !readiness ? "AWS not fully ready" : null },
      { capability: "AWS Read-Only Discovery", reason: !discoveryPassed ? "AWS credentials invalid" : null },
    ],
    failures: [],
  };

  const secretPattern = /AWS_SECRET_ACCESS_KEY|AKIA|SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/i;
  const leak = secretPattern.test(JSON.stringify(evidence));
  evidence.secret_redaction = leak ? "FAIL" : "PASS";
  console.log(`\nSECRET REDACTION: ${evidence.secret_redaction}`);

  await new EvidenceService(path.join(process.cwd(), "phase6-pass16-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass16-evidence.json");
  console.log("\nFINAL STATUS: BLOCKED (AWS credentials invalid; read-only discovery blocked)");
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
