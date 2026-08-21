/**
 * NEXUS Phase 3 — Deployment History Service.
 *
 * Persists deployment records through the shared NexusEngine (the same
 * IndexedDB abstraction used by the rest of the platform). No duplicate
 * persistence layer. A deployment only becomes KNOWN_GOOD (a valid rollback
 * target) after deploy + health + smoke all genuinely PASS.
 */

import type { NexusEngine } from "./db";
import { nid } from "./db";
import type { DeploymentRecord, DeploymentStatus, DeploymentCheckStatus } from "./types";

const STORE = "deployments";

export class DeploymentHistoryService {
  constructor(private engine: NexusEngine) {}

  /** Record (create or overwrite) a deployment. Returns the stored record. */
  async recordDeployment(rec: DeploymentRecord): Promise<DeploymentRecord> {
    await this.engine.put(STORE, rec.id, rec);
    return rec;
  }

  /** Create a new deployment record with system-generated identity. */
  async createDeployment(input: {
    project_id: string;
    environment: string;
    release_id: string;
    image_repository: string;
    image_tag: string;
    image_id?: string | null;
    image_digest?: string | null;
    commit_sha?: string | null;
    container_name: string;
    previous_deployment_id?: string | null;
    is_rollback?: boolean;
    failure_injected?: boolean;
  }): Promise<DeploymentRecord> {
    const rec: DeploymentRecord = {
      id: nid("dep"),
      project_id: input.project_id,
      environment: input.environment,
      release_id: input.release_id,
      artifact_id: null,
      image_repository: input.image_repository,
      image_tag: input.image_tag,
      image_id: input.image_id ?? null,
      image_digest: input.image_digest ?? null,
      commit_sha: input.commit_sha ?? null,
      container_id: null,
      container_name: input.container_name,
      url: null,
      status: "DEPLOYING",
      health_status: null,
      smoke_status: null,
      quality_gate: null,
      verified: false,
      is_rollback: input.is_rollback ?? false,
      failure_injected: input.failure_injected ?? false,
      previous_deployment_id: input.previous_deployment_id ?? null,
      failure_reason: null,
      started_at: Date.now(),
      completed_at: null,
    };
    return this.recordDeployment(rec);
  }

  async updateDeployment(id: string, patch: Partial<DeploymentRecord>): Promise<DeploymentRecord | null> {
    const rec = await this.getDeployment(id);
    if (!rec) return null;
    Object.assign(rec, patch);
    return this.recordDeployment(rec);
  }

  async getDeployment(id: string): Promise<DeploymentRecord | null> {
    return (await this.engine.get<DeploymentRecord>(STORE, id)) ?? null;
  }

  async listDeployments(projectId?: string): Promise<DeploymentRecord[]> {
    const all = projectId
      ? await this.engine.byIndex<DeploymentRecord>(STORE, "byProject", projectId)
      : await this.engine.all<DeploymentRecord>(STORE);
    return all.sort((a, b) => b.started_at - a.started_at);
  }

  /** Most recent deployment for a project/environment (any status). */
  async getCurrentDeployment(projectId: string, environment: string): Promise<DeploymentRecord | null> {
    const list = (await this.listDeployments(projectId)).filter((d) => d.environment === environment);
    return list[0] ?? null;
  }

  /** Most recent KNOWN_GOOD deployment (the current rollback target). */
  async getKnownGoodDeployment(projectId: string, environment: string): Promise<DeploymentRecord | null> {
    const list = (await this.listDeployments(projectId)).filter(
      (d) => d.environment === environment && d.status === "KNOWN_GOOD",
    );
    return list[0] ?? null;
  }

  /**
   * The previous KNOWN_GOOD deployment relative to `current` — the most recent
   * KNOWN_GOOD that started BEFORE the current deployment. This is the
   * rollback target when the current deployment has failed.
   */
  async getPreviousKnownGood(
    projectId: string,
    environment: string,
    currentId: string,
  ): Promise<DeploymentRecord | null> {
    const current = await this.getDeployment(currentId);
    const known = (await this.listDeployments(projectId)).filter(
      (d) => d.environment === environment && d.status === "KNOWN_GOOD",
    );
    const candidates = known.filter((d) => d.id !== currentId && (!current || d.started_at < current.started_at));
    return candidates[0] ?? null;
  }

  async markKnownGood(id: string): Promise<DeploymentRecord | null> {
    return this.updateDeployment(id, {
      status: "KNOWN_GOOD",
      verified: true,
      completed_at: Date.now(),
    });
  }

  async markFailed(id: string, reason: string): Promise<DeploymentRecord | null> {
    return this.updateDeployment(id, {
      status: "FAILED",
      verified: false,
      failure_reason: reason,
      completed_at: Date.now(),
    });
  }

  async setStatus(id: string, status: DeploymentStatus): Promise<DeploymentRecord | null> {
    return this.updateDeployment(id, { status, completed_at: Date.now() });
  }

  async setChecks(
    id: string,
    checks: { health_status?: DeploymentCheckStatus; smoke_status?: DeploymentCheckStatus; quality_gate?: DeploymentCheckStatus },
  ): Promise<DeploymentRecord | null> {
    return this.updateDeployment(id, checks);
  }

  /* ------------------------------------------------------------------ *
   * Legacy aliases — preserved so the existing RollbackAgent and the     *
   * pre-existing unit tests continue to compile unchanged.               *
   * ------------------------------------------------------------------ */

  /** @deprecated alias for getDeployment */
  getById(id: string): Promise<DeploymentRecord | null> {
    return this.getDeployment(id);
  }

  /** @deprecated alias for getCurrentDeployment */
  getCurrent(projectId: string, environment: string): Promise<DeploymentRecord | null> {
    return this.getCurrentDeployment(projectId, environment);
  }

  /** @deprecated alias for getKnownGoodDeployment */
  getKnownGood(projectId: string, environment: string): Promise<DeploymentRecord | null> {
    return this.getKnownGoodDeployment(projectId, environment);
  }

  /** @deprecated alias for listDeployments */
  list(projectId?: string): Promise<DeploymentRecord[]> {
    return this.listDeployments(projectId);
  }
}
