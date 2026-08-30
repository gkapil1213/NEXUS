import { NexusEngine, nid } from "./db";
import { createHash } from "node:crypto";
import type { InfrastructureState, InfrastructureResource } from "./infrastructure-state";

export interface InfrastructureSnapshot {
  id: string;
  project_id: string;
  environment: string;
  provider: string;
  timestamp: string;
  state_hash: string;
  source: "terraform" | "aws" | "docker" | "local";
  resources: InfrastructureResource[];
  desired_hash?: string;
}

export class InfrastructureSnapshotService {
  private engine: NexusEngine;

  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  private key(id: string): string {
    return `infra_snapshot:${id}`;
  }

  async captureSnapshot(input: Omit<InfrastructureSnapshot, "id" | "timestamp" | "state_hash">): Promise<InfrastructureSnapshot> {
    const stateHash = this.hashResources(input.resources);
    const snapshot: InfrastructureSnapshot = {
      ...input,
      id: nid("infra_snap"),
      timestamp: new Date().toISOString(),
      state_hash: stateHash,
    };
    await this.engine.put("kv", this.key(snapshot.id), snapshot);
    return snapshot;
  }

  async getSnapshot(id: string): Promise<InfrastructureSnapshot | undefined> {
    return this.engine.get<InfrastructureSnapshot>("kv", this.key(id));
  }

  hashResources(resources: InfrastructureResource[]): string {
    const normalized = resources
      .map(r => `${r.address}:${r.type}:${r.status}:${r.attributes_hash}`)
      .sort()
      .join("|");
    return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
  }
}
