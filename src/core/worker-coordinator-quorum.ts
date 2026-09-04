import Database from "better-sqlite3";
import { CoordinatorRegistry } from "./worker-coordinator-registry";

export type QuorumStatus = "QUORUM_AVAILABLE" | "QUORUM_LOST" | "QUORUM_UNKNOWN";

export class CoordinatorQuorum {
  constructor(private db: Database.Database, private registry: CoordinatorRegistry, private majorityThresholdFactor: number = 0.5) {}

  evaluate(now: number = Date.now()): QuorumStatus {
    const active = this.registry.listActive(now);
    const total = this.db.prepare("SELECT COUNT(*) as count FROM coordinator_registry").get() as any;
    const totalCount = total?.count ?? 0;
    if (totalCount === 0) return "QUORUM_UNKNOWN";
    const required = Math.floor(totalCount * this.majorityThresholdFactor) + 1;
    if (active.length >= required) return "QUORUM_AVAILABLE";
    return "QUORUM_LOST";
  }
}
