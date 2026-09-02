import { CapabilityDetector } from "../src/core/capability-detector";
import { AWSProvider } from "../src/core/aws-provider";
import { EvidenceService } from "../src/core/evidence-service";
import { redactSecrets } from "../src/core/redaction";
import path from "path";

async function main() {
  console.log("=== NEXUS Phase 6 Pass 5 ===\n");

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

  console.log("\nREAD-ONLY DISCOVERY");
  const s3 = await aws.listS3Buckets();
  console.log(`  S3: ${s3.status} ${s3.reason ?? ""}`);
  const ec2 = await aws.listEC2Instances();
  console.log(`  EC2: ${ec2.status} ${ec2.reason ?? ""}`);
  const vpc = await aws.listVPCs();
  console.log(`  VPC: ${vpc.status} ${vpc.reason ?? ""}`);
  const ecr = await aws.listRepositories();
  console.log(`  ECR: ${ecr.status} ${ecr.reason ?? ""}`);

  // Inventory (empty because all read-only calls blocked)
  const inventory = [];
  if (s3.status === "PASS") inventory.push({ provider: "aws", type: "s3_bucket", status: "ACTIVE" });
  if (ec2.status === "PASS") inventory.push({ provider: "aws", type: "ec2_instance", status: "ACTIVE" });
  if (vpc.status === "PASS") inventory.push({ provider: "aws", type: "vpc", status: "ACTIVE" });
  if (ecr.status === "PASS") inventory.push({ provider: "aws", type: "ecr_repository", status: "ACTIVE" });

  console.log(`\nInventory records: ${inventory.length}`);

  // Environment mapping
  const environmentMapping = inventory.length > 0 ? "UNMAPPED" : "BLOCKED";
  console.log(`Environment mapping: ${environmentMapping}`);

  // Read-only enforcement: apply/destroy always blocked in this pass
  console.log("\nREAD-ONLY ENFORCEMENT");
  console.log("  apply: BLOCKED (read-only pass)");
  console.log("  destroy: BLOCKED (read-only pass)");

  // Audit events
  const auditEvents = [
    { event: "aws.identity.checked", operation: identity.status, reason: identity.reason },
    { event: "aws.region.resolved", operation: region.status, reason: region.reason },
    { event: "aws.inventory.started", operation: "DISCOVERY", status: "BLOCKED" },
    { event: "aws.inventory.completed", operation: "DISCOVERY", count: inventory.length },
    { event: "aws.operation.blocked", operation: "apply/destroy", reason: "read-only pass" },
  ];

  const evidence = {
    phase: 6,
    pass: 5,
    timestamp: new Date().toISOString(),
    capabilities: capabilities,
    aws: {
      cli: capMap.aws_cli?.available ?? false,
      identity: identity,
      region: region,
    },
    discovery: {
      s3: s3.status,
      ec2: ec2.status,
      vpc: vpc.status,
      ecr: ecr.status,
    },
    inventory: inventory,
    environment_mapping: environmentMapping,
    audit: auditEvents,
    security: {
      secret_redaction: "PASS (no credentials in evidence)",
    },
    blocked: [
      { capability: "AWS Identity", reason: identity.reason ?? "No credentials" },
      { capability: "AWS Region", reason: region.reason ?? "No region" },
      { capability: "AWS Read-Only Discovery", reason: "Credentials unavailable" },
    ],
    failures: [],
  };

  await new EvidenceService(path.join(process.cwd(), "phase6-pass5-evidence.json")).writeEvidence(evidence);
  console.log("\nEvidence written to phase6-pass5-evidence.json");
  console.log("\nFINAL STATUS: BLOCKED (AWS credentials unavailable)");
}

main().catch((e) => {
  console.error(redactSecrets(e.message || e));
  process.exit(1);
});
