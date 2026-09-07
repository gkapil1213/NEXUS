import { NexusEngine } from "./db";

export type InstanceHealthState = "HEALTHY" | "DEGRADED" | "SUSPECT" | "OFFLINE" | "QUARANTINED" | "REVOKED";
export type InstanceLifecycleState = "REGISTERED" | "ACTIVE" | "DRAINING" | "RETIRED";
export type LeadershipState = "NONE" | "LEADER" | "FOLLOWER";
export type QuorumStatus = "QUORUM_AVAILABLE" | "QUORUM_LOST" | "QUORUM_DEGRADED" | "QUORUM_UNKNOWN";
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ControlPlaneInstance {
  instanceId: string;
  nodeIdentity: string;
  softwareVersion: string;
  capabilities?: string[];
  lifecycleState: InstanceLifecycleState;
  healthState: InstanceHealthState;
  leadershipState: LeadershipState;
  currentEpochId?: string;
  currentFencingToken?: string;
  lastHeartbeatAt?: number;
  registeredAt: number;
  expiresAt?: number;
}

export class ControlPlaneRegistry {
  constructor(private db: NexusEngine) {}

  register(instance: ControlPlaneInstance): void {
    this.db.prepare(`
      INSERT INTO phase71_instances (
        instance_id, node_identity, software_version, capabilities_json,
        lifecycle_state, health_state, leadership_state, current_epoch_id,
        current_fencing_token, last_heartbeat_at, registered_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        node_identity = excluded.node_identity,
        software_version = excluded.software_version,
        capabilities_json = excluded.capabilities_json,
        lifecycle_state = excluded.lifecycle_state,
        health_state = excluded.health_state,
        leadership_state = excluded.leadership_state,
        current_epoch_id = excluded.current_epoch_id,
        current_fencing_token = excluded.current_fencing_token,
        last_heartbeat_at = excluded.last_heartbeat_at,
        expires_at = excluded.expires_at,
        registered_at = excluded.registered_at
    `).run(
      instance.instanceId,
      instance.nodeIdentity,
      instance.softwareVersion,
      instance.capabilities ? JSON.stringify(instance.capabilities) : null,
      instance.lifecycleState,
      instance.healthState,
      instance.leadershipState,
      instance.currentEpochId,
      instance.currentFencingToken,
      instance.lastHeartbeatAt,
      instance.registeredAt,
      instance.expiresAt
    );
  }

  heartbeat(instanceId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE phase71_instances SET last_heartbeat_at = ?, health_state = 'HEALTHY' WHERE instance_id = ?").run(now, instanceId);
  }

  get(instanceId: string): ControlPlaneInstance | undefined {
    const row = this.db.prepare("SELECT * FROM phase71_instances WHERE instance_id = ?").get(instanceId);
    return row ? this.map(row) : undefined;
  }

  listActive(now: number = Date.now(), heartbeatTimeoutMs: number = 30000): ControlPlaneInstance[] {
    const rows = this.db.prepare("SELECT * FROM phase71_instances WHERE health_state IN ('HEALTHY','DEGRADED')").all() as any[];
    return rows.filter(row => (row.last_heartbeat_at ?? 0) + heartbeatTimeoutMs >= now).map(this.map);
  }

  listAll(): ControlPlaneInstance[] {
    return (this.db.prepare("SELECT * FROM phase71_instances").all() as any[]).map(this.map);
  }

  updateState(instanceId: string, lifecycle: InstanceLifecycleState, health: InstanceHealthState): void {
    this.db.prepare("UPDATE phase71_instances SET lifecycle_state = ?, health_state = ? WHERE instance_id = ?").run(lifecycle, health, instanceId);
  }

  updateLeadership(instanceId: string, leadership: LeadershipState, epochId?: string, token?: string): void {
    this.db.prepare("UPDATE phase71_instances SET leadership_state = ?, current_epoch_id = ?, current_fencing_token = ? WHERE instance_id = ?").run(leadership, epochId, token, instanceId);
  }

  revoke(instanceId: string): void {
    this.db.prepare("UPDATE phase71_instances SET health_state = 'REVOKED', lifecycle_state = 'RETIRED', leadership_state = 'NONE' WHERE instance_id = ?").run(instanceId);
  }

  private map(row: any): ControlPlaneInstance {
    return {
      instanceId: row.instance_id,
      nodeIdentity: row.node_identity,
      softwareVersion: row.software_version,
      capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : undefined,
      lifecycleState: row.lifecycle_state,
      healthState: row.health_state,
      leadershipState: row.leadership_state,
      currentEpochId: row.current_epoch_id,
      currentFencingToken: row.current_fencing_token,
      lastHeartbeatAt: row.last_heartbeat_at,
      registeredAt: row.registered_at,
      expiresAt: row.expires_at,
    };
  }
}

export class ControlPlaneQuorum {
  constructor(private db: NexusEngine, private registry: ControlPlaneRegistry, private majorityThresholdFactor: number = 0.5) {}

  evaluate(now: number = Date.now()): { status: QuorumStatus; activeCount: number; totalCount: number } {
    const total = this.registry.listAll().length;
    const active = this.registry.listActive(now).length;
    if (total === 0) return { status: "QUORUM_UNKNOWN", activeCount: 0, totalCount: 0 };
    const required = Math.floor(total * this.majorityThresholdFactor) + 1;
    if (active >= required) return { status: "QUORUM_AVAILABLE", activeCount: active, totalCount: total };
    if (active > 0) return { status: "QUORUM_DEGRADED", activeCount: active, totalCount: total };
    return { status: "QUORUM_LOST", activeCount: active, totalCount: total };
  }
}

export class FencingTokenManager {
  constructor(private db: NexusEngine) {}

  issue(epochId: string, instanceId: string, now: number = Date.now(), ttlMs: number = 120000): { tokenValue: string; expiresAt: number } {
    const tokenValue = `ft_${epochId}_${now}_${Math.random().toString(36).slice(2)}`;
    this.db.prepare(`
      INSERT INTO phase71_fencing_tokens (token_id, epoch_id, instance_id, token_value, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`token_${now}_${instanceId}_${Math.random().toString(36).slice(2)}`, epochId, instanceId, tokenValue, now, now + ttlMs);
    return { tokenValue, expiresAt: now + ttlMs };
  }

  validate(tokenValue: string, epochId: string, instanceId: string, now: number = Date.now()): boolean {
    const row = this.db.prepare("SELECT * FROM phase71_fencing_tokens WHERE token_value = ?").get(tokenValue) as any;
    return !!row && row.epoch_id === epochId && row.instance_id === instanceId && row.revoked_at === null && row.expires_at > now;
  }

  revoke(tokenValue: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE phase71_fencing_tokens SET revoked_at = ? WHERE token_value = ?").run(now, tokenValue);
  }
}

export class ControlPlaneEpochManager {
  constructor(private db: NexusEngine, private fencing: FencingTokenManager) {}

  create(instanceId: string, quorumStatus: QuorumStatus, now: number = Date.now(), ttlMs: number = 120000): { epochId: string; term: number; fencingToken: string } {
    const term = this.getCurrentTerm() + 1;
    const epochId = `epoch_${term}_${now}`;
    const { tokenValue } = this.fencing.issue(epochId, instanceId, now, ttlMs);
    this.db.prepare(`
      INSERT INTO phase71_epochs (epoch_id, term, instance_id, fencing_token, created_at, expires_at, fenced, quorum_state)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(epochId, term, instanceId, tokenValue, now, now + ttlMs, quorumStatus);
    return { epochId, term, fencingToken: tokenValue };
  }

  getCurrentTerm(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(term),0) as term FROM phase71_epochs").get() as any;
    return row.term;
  }

  getLatest(): { epochId: string; term: number; instanceId: string; fencingToken: string } | undefined {
    const row = this.db.prepare("SELECT * FROM phase71_epochs ORDER BY term DESC LIMIT 1").get() as any;
    if (!row) return undefined;
    return { epochId: row.epoch_id, term: row.term, instanceId: row.instance_id, fencingToken: row.fencing_token };
  }

  fence(epochId: string): void {
    this.db.prepare("UPDATE phase71_epochs SET fenced = 1 WHERE epoch_id = ?").run(epochId);
  }

  isValid(epochId: string, now: number = Date.now()): boolean {
    const row = this.db.prepare("SELECT * FROM phase71_epochs WHERE epoch_id = ? AND fenced = 0 AND expires_at > ?").get(epochId, now);
    return !!row;
  }
}

export class ControlPlaneLeaseManager {
  constructor(private db: NexusEngine, private fencing: FencingTokenManager) {}

  acquire(instanceId: string, epochId: string, fencingToken: string, now: number = Date.now(), ttlMs: number = 60000): { leaseId: string; expiresAt: number } {
    const leaseId = `lease_${instanceId}_${epochId}`;
    this.db.prepare(`
      INSERT INTO phase71_leadership_leases (lease_id, instance_id, epoch_id, fencing_token, state, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      ON CONFLICT(instance_id, epoch_id) DO UPDATE SET
        fencing_token = excluded.fencing_token,
        state = 'ACTIVE',
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    `).run(leaseId, instanceId, epochId, fencingToken, now, now + ttlMs);
    return { leaseId, expiresAt: now + ttlMs };
  }

  renew(leaseId: string, now: number = Date.now(), ttlMs: number = 60000): void {
    this.db.prepare("UPDATE phase71_leadership_leases SET expires_at = ?, renewed_at = ? WHERE lease_id = ? AND state = 'ACTIVE'").run(now + ttlMs, now, leaseId);
  }

  release(leaseId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE phase71_leadership_leases SET state = 'RELEASED', released_at = ? WHERE lease_id = ?").run(now, leaseId);
  }

  expire(leaseId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE phase71_leadership_leases SET state = 'EXPIRED' WHERE lease_id = ? AND expires_at <= ?").run(leaseId, now);
  }

  getActiveLease(instanceId: string): { leaseId: string; epochId: string; fencingToken: string; expiresAt: number } | undefined {
    const row = this.db.prepare("SELECT * FROM phase71_leadership_leases WHERE instance_id = ? AND state = 'ACTIVE' ORDER BY expires_at DESC LIMIT 1").get(instanceId) as any;
    if (!row) return undefined;
    return { leaseId: row.lease_id, epochId: row.epoch_id, fencingToken: row.fencing_token, expiresAt: row.expires_at };
  }

  isValid(instanceId: string, epochId: string, fencingToken: string, now: number = Date.now()): boolean {
    const active = this.getActiveLease(instanceId);
    return !!active && active.epochId === epochId && active.fencingToken === fencingToken && active.expiresAt > now;
  }
}

export class WorkloadOwnershipManager {
  constructor(private db: NexusEngine) {}

  claim(workloadId: string, instanceId: string, epochId: string, fencingToken: string, now: number = Date.now(), ttlMs: number = 60000): void {
    this.db.prepare(`
      INSERT INTO phase71_workload_ownership (workload_id, instance_id, epoch_id, fencing_token, state, acquired_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, 'CLAIMED', ?, ?, ?)
      ON CONFLICT(workload_id) DO UPDATE SET
        instance_id = excluded.instance_id,
        epoch_id = excluded.epoch_id,
        fencing_token = excluded.fencing_token,
        state = 'CLAIMED',
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(workloadId, instanceId, epochId, fencingToken, now, now + ttlMs, now);
  }

  get(workloadId: string): any {
    return this.db.prepare("SELECT * FROM phase71_workload_ownership WHERE workload_id = ?").get(workloadId);
  }

  validate(workloadId: string, instanceId: string, epochId: string, fencingToken: string, now: number = Date.now()): boolean {
    const row = this.get(workloadId) as any;
    return !!row && row.instance_id === instanceId && row.epoch_id === epochId && row.fencing_token === fencingToken && row.state === 'CLAIMED' && row.expires_at > now;
  }

  release(workloadId: string, instanceId: string, fencingToken: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE phase71_workload_ownership SET state = 'RELEASED', updated_at = ? WHERE workload_id = ? AND instance_id = ? AND fencing_token = ?").run(now, workloadId, instanceId, fencingToken);
  }

  transfer(workloadId: string, fromInstance: string, toInstance: string, fromToken: string, newEpochId: string, newToken: string, now: number = Date.now()): void {
    this.db.transaction(() => {
      this.release(workloadId, fromInstance, fromToken, now);
      this.claim(workloadId, toInstance, newEpochId, newToken, now);
    });
  }
}

export class ControlPlaneCircuitBreaker {
  constructor(private db: NexusEngine) {}

  getState(scope: string): { state: BreakerState; version: number } {
    const row = this.db.prepare("SELECT * FROM phase71_circuit_breakers WHERE scope = ? ORDER BY version DESC LIMIT 1").get(scope) as any;
    return { state: row?.state ?? "CLOSED", version: row?.version ?? 0 };
  }

  open(scope: string, reason: string, now: number = Date.now()): void {
    const { version } = this.getState(scope);
    this.db.prepare("INSERT INTO phase71_circuit_breakers (breaker_id, scope, state, opened_at, reason, version) VALUES (?, ?, 'OPEN', ?, ?, ?)").run(`cb_${scope}_${version+1}`, scope, now, reason, version+1);
  }

  halfOpen(scope: string, now: number = Date.now()): void {
    const { version } = this.getState(scope);
    this.db.prepare("INSERT INTO phase71_circuit_breakers (breaker_id, scope, state, half_open_at, version) VALUES (?, ?, 'HALF_OPEN', ?, ?)").run(`cb_${scope}_${version+1}`, scope, now, version+1);
  }

  close(scope: string, now: number = Date.now()): void {
    const { version } = this.getState(scope);
    this.db.prepare("INSERT INTO phase71_circuit_breakers (breaker_id, scope, state, closed_at, version) VALUES (?, ?, 'CLOSED', ?, ?)").run(`cb_${scope}_${version+1}`, scope, now, version+1);
  }

  allow(scope: string): boolean {
    const { state } = this.getState(scope);
    return state === "CLOSED" || state === "HALF_OPEN";
  }
}

export class CoordinationAudit {
  constructor(private db: NexusEngine) {}
  record(event: string, entity: string, actor: string, details: Record<string, any>, now: number = Date.now()): void {
    const auditId = `aud_${now}_${Math.random().toString(36).slice(2)}`;
    this.db.prepare(`
      INSERT INTO phase71_audit (audit_id, event, entity, actor, instance_id, epoch_id, fencing_token, prev_state, new_state, reason, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(auditId, event, entity, actor, details.instanceId, details.epochId, details.fencingToken, details.prevState, details.newState, details.reason, details.correlationId, now);
  }
}

export class Phase71Coordinator {
  readonly registry: ControlPlaneRegistry;
  readonly quorum: ControlPlaneQuorum;
  readonly fencing: FencingTokenManager;
  readonly epochs: ControlPlaneEpochManager;
  readonly leases: ControlPlaneLeaseManager;
  readonly ownership: WorkloadOwnershipManager;
  readonly breaker: ControlPlaneCircuitBreaker;
  readonly audit: CoordinationAudit;
  private db: NexusEngine;

  constructor(db: NexusEngine) {
    this.db = db;
    this.registry = new ControlPlaneRegistry(db);
    this.quorum = new ControlPlaneQuorum(db, this.registry);
    this.fencing = new FencingTokenManager(db);
    this.epochs = new ControlPlaneEpochManager(db, this.fencing);
    this.leases = new ControlPlaneLeaseManager(db, this.fencing);
    this.ownership = new WorkloadOwnershipManager(db);
    this.breaker = new ControlPlaneCircuitBreaker(db);
    this.audit = new CoordinationAudit(db);
  }

  registerInstance(instance: ControlPlaneInstance): void {
    this.registry.register(instance);
    this.audit.record("REGISTER_INSTANCE", "control_plane_instance", instance.instanceId, { instanceId: instance.instanceId, newState: instance.healthState });
  }

  electLeader(candidateInstanceId?: string): { status: string; leaderId?: string; epochId?: string; term?: number; fencingToken?: string } {
    const q = this.quorum.evaluate();
    if (q.status !== "QUORUM_AVAILABLE") return { status: q.status };
    const active = this.registry.listActive();
    if (active.length === 0) return { status: "NO_CANDIDATE" };
    let leaderInstance: ControlPlaneInstance;
    if (candidateInstanceId) {
      const found = active.find(i => i.instanceId === candidateInstanceId);
      if (!found) return { status: "CANDIDATE_INACTIVE" };
      leaderInstance = found;
    } else {
      active.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
      leaderInstance = active[0];
    }
    const { epochId, term, fencingToken } = this.epochs.create(leaderInstance.instanceId, q.status);
    this.leases.acquire(leaderInstance.instanceId, epochId, fencingToken);
    this.registry.updateLeadership(leaderInstance.instanceId, "LEADER", epochId, fencingToken);
    for (const i of active) if (i.instanceId !== leaderInstance.instanceId) this.registry.updateLeadership(i.instanceId, "FOLLOWER", epochId, fencingToken);
    this.audit.record("ELECT_LEADER", "control_plane_instance", leaderInstance.instanceId, { instanceId: leaderInstance.instanceId, epochId, fencingToken, newState: "LEADER" });
    return { status: "ELECTED", leaderId: leaderInstance.instanceId, epochId, term, fencingToken };
  }

  validateLeadership(instanceId: string, epochId: string, fencingToken: string, now: number = Date.now()): boolean {
    return this.epochs.isValid(epochId, now) && this.leases.isValid(instanceId, epochId, fencingToken, now) && this.fencing.validate(fencingToken, epochId, instanceId, now);
  }

  claimWorkload(workloadId: string, instanceId: string, epochId: string, fencingToken: string): void {
    if (!this.validateLeadership(instanceId, epochId, fencingToken)) throw new Error("INVALID_LEADERSHIP");
    if (!this.breaker.allow("global")) throw new Error("CIRCUIT_OPEN");
    this.ownership.claim(workloadId, instanceId, epochId, fencingToken);
    this.audit.record("CLAIM_WORKLOAD", workloadId, instanceId, { instanceId, epochId, fencingToken, newState: "CLAIMED" });
  }

  coordinateDispatch(workloadId: string, instanceId: string, epochId: string, fencingToken: string, governanceApproved: boolean, safetyApproved: boolean): string {
    if (!this.validateLeadership(instanceId, epochId, fencingToken)) return "REJECTED_STALE_LEADER";
    if (!this.ownership.validate(workloadId, instanceId, epochId, fencingToken)) return "REJECTED_OWNERSHIP";
    if (!governanceApproved) return "REJECTED_GOVERNANCE";
    if (!safetyApproved) return "REJECTED_SAFETY";
    if (!this.breaker.allow("global")) return "REJECTED_CIRCUIT_OPEN";
    return "DISPATCH_ALLOWED";
  }

  replayDecision(decisionId: string, originalDecision: string, recomputedDecision: string): boolean {
    const match = originalDecision === recomputedDecision;
    if (!match) {
      this.db.prepare("INSERT INTO phase71_conflicts (conflict_id, conflict_type, entity_id, resolution, created_at) VALUES (?, 'REPLAY_DIVERGENCE', ?, 'DETECTED', ?)").run(`conf_${Date.now()}_${Math.random().toString(36).slice(2)}`, decisionId, Date.now());
    }
    return match;
  }
}
