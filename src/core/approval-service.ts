import { promises as fs } from "node:fs";
import path from "node:path";
import { nid } from "./db";

export interface ApprovalRecord {
  approval_id: string;
  release_id: string;
  artifact_digest: string | null;
  environment: string;
  approver: string;
  timestamp: number;
  decision: "APPROVED" | "REJECTED";
  reason: string;
}

export class ApprovalService {
  private statePath = path.join(process.cwd(), "approval-state.json");
  private approvals: ApprovalRecord[] = [];

  constructor() {
    this.loadState();
  }

  private async loadState() {
    try {
      const data = await fs.readFile(this.statePath, "utf-8");
      this.approvals = JSON.parse(data);
    } catch {}
  }

  private async saveState() {
    await fs.writeFile(this.statePath, JSON.stringify(this.approvals, null, 2));
  }

  async recordApproval(input: {
    release_id: string;
    artifact_digest: string | null;
    environment: string;
    approver: string;
    decision: "APPROVED" | "REJECTED";
    reason: string;
  }): Promise<ApprovalRecord> {
    const approval: ApprovalRecord = {
      approval_id: nid("appr"),
      release_id: input.release_id,
      artifact_digest: input.artifact_digest,
      environment: input.environment,
      approver: input.approver,
      timestamp: Date.now(),
      decision: input.decision,
      reason: input.reason,
    };
    this.approvals.push(approval);
    await this.saveState();
    return approval;
  }

  listForRelease(releaseId: string): ApprovalRecord[] {
    return this.approvals.filter((a) => a.release_id === releaseId);
  }
}