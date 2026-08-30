import { createHash } from "node:crypto";
import { nid, NexusEngine } from "./db";
import { Err } from "./errors";

export interface InfrastructureApproval {
  id: string;
  plan_id: string;
  environment: string;
  provider: string;
  workspace: string;
  commit_sha: string;
  artifact_digest?: string;
  plan_digest: string;
  requested_changes: {
    create: number;
    update: number;
    replace: number;
    destroy: number;
  };
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  approver: string;
  approved_at: string;
  status: "APPROVED" | "REJECTED";
}

export function computePlanDigest(planJson: string): string {
  return `sha256:${createHash("sha256").update(planJson).digest("hex")}`;
}

export class InfrastructureApprovalService {
  private engine: NexusEngine;
  private readonly store = "kv"; // reuse kv store with prefixed keys

  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  private key(id: string): string {
    return `infra_approval:${id}`;
  }

  async requestApproval(input: Omit<InfrastructureApproval, "id" | "approved_at" | "status">): Promise<InfrastructureApproval> {
    const approval: InfrastructureApproval = {
      id: nid("infraappr"),
      ...input,
      approved_at: new Date().toISOString(),
      status: "APPROVED",
    };
    await this.engine.put("kv", this.key(approval.id), approval);
    return approval;
  }

  async getApproval(id: string): Promise<InfrastructureApproval | undefined> {
    return this.engine.get<InfrastructureApproval>("kv", this.key(id));
  }

  async verifyPlanDigest(plan_id: string, currentPlanDigest: string): Promise<boolean> {
    const approval = await this.getApproval(plan_id);
    if (!approval || approval.status !== "APPROVED") return false;
    return approval.plan_digest === currentPlanDigest;
  }
}