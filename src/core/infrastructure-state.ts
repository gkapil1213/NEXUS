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
  | "APPROVED"
  | "APPLYING"
  | "APPLIED"
  | "VERIFYING"
  | "HEALTHY"
  | "DRIFTED"
  | "FAILED"
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
    const updated: InfrastructureState = { ...existing, ...updates, updated_at: new Date().toISOString() };
    await this.engine.put("kv", this.key(id), updated);
    return updated;
  }
}