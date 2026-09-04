import Database from "better-sqlite3";
import { CoordinatorRegistry } from "./worker-coordinator-registry";
import { CoordinatorQuorum } from "./worker-coordinator-quorum";
import { CoordinatorEpochManager } from "./worker-coordinator-epoch";

export class CoordinatorElection {
  constructor(
    private db: Database.Database,
    private registry: CoordinatorRegistry,
    private quorum: CoordinatorQuorum,
    private epochManager: CoordinatorEpochManager
  ) {}

  electLeader(candidateId: string): { leaderId?: string; epochId?: string; term?: number; status: string } {
    // Ensure quorum
    const quorumStatus = this.quorum.evaluate();
    if (quorumStatus !== "QUORUM_AVAILABLE") {
      return { status: "QUORUM_LOST" };
    }

    // Determine highest-priority active coordinator by stable ID (for determinism)
    const activeCoordinators = this.registry.listActive();
    if (activeCoordinators.length === 0) return { status: "NO_CANDIDATE" };

    // Sort by coordinatorId ascending for deterministic tie-break
    activeCoordinators.sort((a, b) => a.coordinatorId.localeCompare(b.coordinatorId));
    const leader = activeCoordinators[0];

    // Create new epoch (term = previous + 1)
    const nextTerm = this.epochManager.getCurrentTerm() + 1;
    const { epochId, term } = this.epochManager.create(leader.coordinatorId, nextTerm);

    // Persist leadership record
    this.db.prepare(`
      INSERT INTO control_plane_leadership (
        term_id, coordinator_id, epoch_id, quorum_status, state, started_at, expires_at, updated_at
      ) VALUES (?, ?, ?, 'QUORUM_AVAILABLE', 'ACTIVE', ?, ?, ?)
    `).run(
      `leadership_${term}`,
      leader.coordinatorId,
      epochId,
      Date.now(),
      Date.now() + 60000,
      Date.now()
    );

    // Update registry
    this.registry.updateState(leader.coordinatorId, "ACTIVE");
    this.registry.updateEpoch(leader.coordinatorId, epochId);

    return { leaderId: leader.coordinatorId, epochId, term, status: "ELECTED" };
  }
}
