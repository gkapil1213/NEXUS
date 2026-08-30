import { NexusEngine, nid } from "./db";
import { Err } from "./errors";
import type { InfrastructurePolicyVerdict } from "./infrastructure-policy";
import type { TerraformService } from "./terraform-service";
import type { AWSProvider } from "./aws-provider";

export type InfrastructureDeploymentStatus =
  | "DRAFT"
  | "PLANNED"
  | "POLICY_CHECK"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "APPLYING"
  | "APPLIED"
  | "VERIFYING"
  | "HEALTHY"
  | "FAILED"
  | "ROLLED_BACK"
  | "BLOCKED";

export interface InfrastructureDeployment {
  id: string;
  project_id: string;
  environment: string;
  plan_digest: string;
  artifact_digest?: string;
  status: InfrastructureDeploymentStatus;
  created_at: string;
  updated_at: string;
}

export class InfrastructureDeploymentOrchestrator {
  private engine: NexusEngine;
  private terraform: TerraformService;
  private aws: AWSProvider;

  constructor(engine: NexusEngine, terraform: TerraformService, aws: AWSProvider) {
    this.engine = engine;
    this.terraform = terraform;
    this.aws = aws;
  }

  private key(id: string): string {
    return `infra_deployment:${id}`;
  }

  private isValidTransition(from: InfrastructureDeploymentStatus, to: InfrastructureDeploymentStatus): boolean {
    const valid: Record<string, InfrastructureDeploymentStatus[]> = {
      DRAFT: ["PLANNED", "BLOCKED"],
      PLANNED: ["POLICY_CHECK", "BLOCKED"],
      POLICY_CHECK: ["WAITING_APPROVAL", "BLOCKED"],
      WAITING_APPROVAL: ["APPROVED", "BLOCKED"],
      APPROVED: ["APPLYING", "BLOCKED"],
      APPLYING: ["APPLIED", "FAILED", "BLOCKED"],
      APPLIED: ["VERIFYING", "BLOCKED"],
      VERIFYING: ["HEALTHY", "FAILED", "BLOCKED"],
      HEALTHY: [],
      FAILED: [],
      ROLLED_BACK: [],
      BLOCKED: [],
    };
    return (valid[from] ?? []).includes(to);
  }

  async createDeployment(input: { project_id: string; environment: string; plan_digest: string; artifact_digest?: string }): Promise<InfrastructureDeployment> {
    const now = new Date().toISOString();
    const dep: InfrastructureDeployment = {
      id: nid("infra_dep"),
      project_id: input.project_id,
      environment: input.environment,
      plan_digest: input.plan_digest,
      artifact_digest: input.artifact_digest,
      status: "DRAFT",
      created_at: now,
      updated_at: now,
    };
    await this.engine.put("kv", this.key(dep.id), dep);
    return dep;
  }

  async transition(id: string, to: InfrastructureDeploymentStatus): Promise<InfrastructureDeployment | undefined> {
    const dep = await this.engine.get<InfrastructureDeployment>("kv", this.key(id));
    if (!dep) throw Err.validation("DEPLOYMENT_NOT_FOUND", "infrastructure deployment not found");
    if (!this.isValidTransition(dep.status, to)) {
      throw Err.validation("ILLEGAL_TRANSITION", `Cannot transition from ${dep.status} to ${to}`);
    }
    const updated = { ...dep, status: to, updated_at: new Date().toISOString() };
    await this.engine.put("kv", this.key(id), updated);
    return updated;
  }

  async getDeployment(id: string): Promise<InfrastructureDeployment | undefined> {
    return this.engine.get<InfrastructureDeployment>("kv", this.key(id));
  }

  async ensureIdempotent(project_id: string, environment: string, plan_digest: string): Promise<InfrastructureDeployment | undefined> {
    const all = await this.engine.all<InfrastructureDeployment>("kv");
    return all.find(d => d.project_id === project_id && d.environment === environment && d.plan_digest === plan_digest);
  }

  async authorizeApply(deployment: InfrastructureDeployment, policyVerdicts: InfrastructurePolicyVerdict[], planDigestMatches: boolean): Promise<{ status: "PASS" | "BLOCKED" | "FAIL"; reason: string }> {
    const tfAvailable = await this.terraform.isAvailable();
    const awsAvailable = (await this.aws.getIdentity()).status === "PASS";
    if (!tfAvailable) return { status: "BLOCKED", reason: "Terraform unavailable" };
    if (!awsAvailable) return { status: "BLOCKED", reason: "AWS unavailable" };
    if (!planDigestMatches) return { status: "BLOCKED", reason: "Plan digest mismatch" };
    if (!policyVerdicts.every(v => v.passed)) return { status: "FAIL", reason: "Policy failure" };
    if (deployment.status !== "APPROVED") return { status: "BLOCKED", reason: "Deployment not approved" };
    return { status: "PASS", reason: "Authorized" };
  }
}