import { promises as fs } from "node:fs";
import path from "node:path";
import { nid } from "./db";

export type ReleaseStatus =
  | "DRAFT"
  | "SECURITY_REVIEW"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "DEPLOYING"
  | "VERIFIED"
  | "REJECTED"
  | "FAILED"
  | "ROLLED_BACK";

export interface ReleaseRecord {
  release_id: string;
  version: string;
  commit_sha: string;
  artifact_digest: string | null;
  environment: string;
  status: ReleaseStatus;
  created_at: number;
  updated_at: number;
  metadata: Record<string, string>;
}

export interface ReleaseTransition {
  from: ReleaseStatus | "*";
  to: ReleaseStatus;
}

const ALLOWED_TRANSITIONS: ReleaseTransition[] = [
  { from: "DRAFT", to: "SECURITY_REVIEW" },
  { from: "SECURITY_REVIEW", to: "READY_FOR_APPROVAL" },
  { from: "SECURITY_REVIEW", to: "REJECTED" },
  { from: "READY_FOR_APPROVAL", to: "APPROVED" },
  { from: "READY_FOR_APPROVAL", to: "REJECTED" },
  { from: "APPROVED", to: "DEPLOYING" },
  { from: "DEPLOYING", to: "VERIFIED" },
  { from: "DEPLOYING", to: "FAILED" },
  { from: "DEPLOYING", to: "ROLLED_BACK" },
  { from: "VERIFIED", to: "ROLLED_BACK" },
  { from: "FAILED", to: "ROLLED_BACK" },
];

export class ReleaseService {
  private statePath = path.join(process.cwd(), "release-state.json");
  private releases: ReleaseRecord[] = [];

  constructor() {
    this.loadState();
  }

  private async loadState() {
    try {
      const data = await fs.readFile(this.statePath, "utf-8");
      this.releases = JSON.parse(data);
    } catch {}
  }

  private async saveState() {
    await fs.writeFile(this.statePath, JSON.stringify(this.releases, null, 2));
  }

  async createDraft(version: string, commitSha: string, environment: string, metadata: Record<string, string> = {}): Promise<ReleaseRecord> {
    const now = Date.now();
    const release: ReleaseRecord = {
      release_id: nid("rel"),
      version,
      commit_sha: commitSha,
      artifact_digest: metadata.artifact_digest ?? null,
      environment,
      status: "DRAFT",
      created_at: now,
      updated_at: now,
      metadata,
    };
    this.releases.push(release);
    await this.saveState();
    return release;
  }

  async transition(releaseId: string, to: ReleaseStatus): Promise<ReleaseRecord> {
    const release = this.releases.find((r) => r.release_id === releaseId);
    if (!release) throw new Error(`Release ${releaseId} not found`);

    const allowed = ALLOWED_TRANSITIONS.some(
      (t) => (t.from === "*" || t.from === release.status) && t.to === to
    );
    if (!allowed) {
      throw new Error(`Invalid transition from ${release.status} to ${to}`);
    }

    release.status = to;
    release.updated_at = Date.now();
    await this.saveState();
    return release;
  }

  get(releaseId: string): ReleaseRecord | undefined {
    return this.releases.find((r) => r.release_id === releaseId);
  }

  list(): ReleaseRecord[] {
    return [...this.releases].sort((a, b) => b.created_at - a.created_at);
  }
}