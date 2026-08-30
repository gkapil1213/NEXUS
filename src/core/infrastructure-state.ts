import { NexusEngine, nid } from "./db";
import { Err } from "./errors";

export type InfrastructureResourceStatus = "ACTIVE" | "CREATING" | "UPDATING" | "DELETING" | "FAILED" | "UNKNOWN";

export interface InfrastructureResource {
  address: string;
  type: string;
  name: string;
  provider: string;
  region?: string;
  id?: string;
  status: InfrastructureResourceStatus;
  attributes_hash: string;
  observed_at: string;
}

export type InfrastructureStateStatus =
  | "UNKNOWN"
  | "PLANNED"
  | "APPLYING"
  | "APPLIED"
  | "VERIFYING"
  | "HEALTHY"
  | "DEGRADED"
  | "FAILED"
  | "RECOVERING"
  | "ROLLED_BACK"
  | "DESTROYED";

export interface InfrastructureState {
  id: string;
  project_id: string;
  environment: string;
  provider: string;
  region: string;
  workspace: string;
  state_version: number;
  plan_digest: string;
  artifact_digest?: string;
  status: InfrastructureStateStatus;
  resource_count: number;
  resources: InfrastructureResource[];
  last_verified_at?: string;
  created_at: string;
  updated_at: string;
}

const VALID_TRANSITIONS: Record<InfrastructureStateStatus, InfrastructureStateStatus[]> = {
  UNKNOWN: ["PLANNED", "FAILED"],
  PLANNED: ["APPLYING", "FAILED"],
  APPLYING: ["APPLIED", "FAILED"],
  APPLIED: ["VERIFYING", "FAILED"],
  VERIFYING: ["HEALTHY", "DEGRADED", "FAILED"],
  HEALTHY: ["DEGRADED", "FAILED"],
  DEGRADED: ["HEALTHY", "FAILED", "RECOVERING"],
  FAILED: ["RECOVERING", "ROLLED_BACK"],
  RECOVERING: ["HEALTHY", "DEGRADED", "FAILED", "ROLLED_BACK"],
  ROLLED_BACK: ["HEALTHY", "FAILED"],
  DESTROYED: [],
};

export class InfrastructureStateService {
  private engine: NexusEngine;

  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  private key(id: string): string {
    return `infra_state:${id}`;
  }

  async saveState(input: Omit<InfrastructureState, "id" | "created_at" | "updated_at">): Promise<InfrastructureState> {
    const now = new Date().toISOString();
    const state: InfrastructureState = {
      ...input,
      id: nid("infra_state"),
      created_at: now,
      updated_at: now,
    };
    await this.engine.put("kv", this.key(state.id), state);
    return state;
  }

  async getState(id: string): Promise<InfrastructureState | undefined> {
    return this.engine.get<InfrastructureState>("kv", this.key(id));
  }

  async updateState(id: string, updates: Partial<InfrastructureState>): Promise<InfrastructureState | undefined> {
    const existing = await this.getState(id);
    if (!existing) return undefined;

    // Validate transition if status changes
    if (updates.status && updates.status !== existing.status) {
      if (!VALID_TRANSITIONS[existing.status]?.includes(updates.status)) {
        throw Err.validation("ILLEGAL_STATE_TRANSITION", `Cannot transition from ${existing.status} to ${updates.status}`);
      }
    }

    const updated: InfrastructureState = { ...existing, ...updates, updated_at: new Date().toISOString() };
    await this.engine.put("kv", this.key(id), updated);
    return updated;
  }
}