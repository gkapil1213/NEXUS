// src/core/worker-phase72.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'FAILED' | 'DRAINING' | 'QUARANTINED';
export type LifecycleState = 'ACTIVE' | 'INACTIVE' | 'DRAINING' | 'FAILED' | 'QUARANTINED';
export type DRRole = 'PRIMARY' | 'SECONDARY' | 'STANDBY' | 'DRAINING' | 'FAILED';

export interface GlobalTopologyNode {
  id: string;
  node_type: 'global' | 'region' | 'cluster' | 'fleet' | 'worker' | 'provider' | 'project' | 'environment' | 'failure_domain';
  parent_id?: string;
  name: string;
  health_state: HealthState;
  lifecycle_state: LifecycleState;
  capacity: Record<string, any>;
  governance_state: string;
  protection_level: string;
}

export class Phase72ControlPlane {
  private engine: NexusEngine;
  private lastEpoch = 0;

  private get db() {
    return {
      get: (sql: string, params?: unknown[]) => this.engine.prepare(sql).get(...(params ?? [])) as any,
      all: (sql: string, params?: unknown[]) => this.engine.prepare(sql).all(...(params ?? [])) as any,
      run: (sql: string, params?: unknown[]) => this.engine.prepare(sql).run(...(params ?? [])) as any,
    };
  }

  constructor(engine: NexusEngine) {
    this.engine = engine;
  }

  // ========== Topology Management ==========
  async registerRegion(input: {
    id: string;
    parent_id?: string;
    name: string;
    provider: string;
    geography: string;
    dr_role?: DRRole;
    protection_level?: string;
  }): Promise<GlobalTopologyNode> {
    const parent = await this.db.get('SELECT * FROM global_topology WHERE id = ?', [input.parent_id ?? 'global']);
    if (!parent || parent.node_type !== 'global') throw new Error('Parent topology node not found');
    const node: GlobalTopologyNode = {
      id: input.id,
      node_type: 'region',
      parent_id: input.parent_id ?? 'global',
      name: input.name,
      health_state: 'UNKNOWN',
      lifecycle_state: 'ACTIVE',
      capacity: {},
      governance_state: 'ALLOW',
      protection_level: input.protection_level ?? 'STANDARD'
    };
    await this.db.run(
      `INSERT INTO global_topology (id, node_type, parent_id, name, health_state, lifecycle_state, capacity, governance_state, protection_level)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
      [node.id, node.node_type, node.parent_id, node.name, node.health_state, node.lifecycle_state, JSON.stringify(node.capacity), node.governance_state, node.protection_level]
    );
    await this.db.run(
      `INSERT INTO regions (id, provider, geography, dr_role, health, protection_level)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
      [input.id, input.provider, input.geography, input.dr_role ?? 'PRIMARY', 'UNKNOWN', input.protection_level ?? 'STANDARD']
    );
    return node;
  }

  async registerCluster(input: {
    id: string;
    parent_id: string;
    name: string;
    provider: string;
    environment: string;
    project_scope: string;
    protection_level?: string;
  }): Promise<GlobalTopologyNode> {
    const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.parent_id]);
    if (!region) throw new Error('Parent region not found');
    const node: GlobalTopologyNode = {
      id: input.id,
      node_type: 'cluster',
      parent_id: input.parent_id,
      name: input.name,
      health_state: 'UNKNOWN',
      lifecycle_state: 'ACTIVE',
      capacity: {},
      governance_state: 'ALLOW',
      protection_level: input.protection_level ?? 'STANDARD'
    };
    await this.db.run(
      `INSERT INTO global_topology (id, node_type, parent_id, name, health_state, lifecycle_state, capacity, governance_state, protection_level)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
      [node.id, node.node_type, node.parent_id, node.name, node.health_state, node.lifecycle_state, JSON.stringify(node.capacity), node.governance_state, node.protection_level]
    );
    await this.db.run(
      `INSERT INTO clusters (id, region_id, provider, environment, project_scope, health, protection_level)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
      [input.id, input.parent_id, input.provider, input.environment, input.project_scope, 'UNKNOWN', input.protection_level ?? 'STANDARD']
    );
    return node;
  }

  async registerFailureDomain(input: {
    scope: 'worker' | 'fleet' | 'cluster' | 'region' | 'provider' | 'project' | 'environment';
    entity_id: string;
    state?: 'ACTIVE' | 'DEGRADED' | 'FAILED' | 'QUARANTINED';
  }): Promise<void> {
    const entity = await this.db.get('SELECT id FROM global_topology WHERE id = ?', [input.entity_id]);
    if (!entity) throw new Error('Entity not found');
    await this.db.run(
      `INSERT INTO failure_domains (id, scope, entity_id, state)
       VALUES (?,?,?,?)
       ON CONFLICT(scope, entity_id) DO UPDATE SET state = excluded.state`,
      [uuidv4(), input.scope, input.entity_id, input.state ?? 'ACTIVE']
    );
  }

  // ========== Health and Capacity Observation ==========
  async observeTopologyHealth(input: {
    entity_id: string;
    health_state: HealthState;
    source: string;
    correlation_id?: string;
    details?: Record<string, any>;
  }): Promise<void> {
    const correlationId = input.correlation_id ?? uuidv4();
    await this.db.run(
      `INSERT INTO topology_health (id, entity_id, health_state, observed_at, source, details, correlation_id)
       VALUES (?,?,?,datetime('now'),?,?,?)`,
      [uuidv4(), input.entity_id, input.health_state, input.source, JSON.stringify(input.details ?? {}), correlationId]
    );
    await this.db.run(
      `UPDATE global_topology SET health_state = ?, updated_at = datetime('now') WHERE id = ?`,
      [input.health_state, input.entity_id]
    );
  }

  async observeTopologyCapacity(input: {
    entity_id: string;
    total_capacity: number;
    available_capacity: number;
    reserved_capacity?: number;
    active_capacity?: number;
    concurrency?: number;
    queued_workloads?: number;
    correlation_id?: string;
  }): Promise<void> {
    const correlationId = input.correlation_id ?? uuidv4();
    const utilization = input.total_capacity > 0 ? ((input.total_capacity - input.available_capacity) / input.total_capacity) * 100 : 0;
    await this.db.run(
      `INSERT INTO topology_capacity (id, entity_id, total_capacity, available_capacity, reserved_capacity, active_capacity, utilization, concurrency, queued_workloads, observed_at, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)`,
      [uuidv4(), input.entity_id, input.total_capacity, input.available_capacity, input.reserved_capacity ?? 0, input.active_capacity ?? 0, utilization, input.concurrency ?? 0, input.queued_workloads ?? 0, correlationId]
    );
  }

  async calculateGlobalHealth(): Promise<HealthState> {
    const rows = await this.db.all('SELECT health_state, COUNT(*) as cnt FROM global_topology GROUP BY health_state');
    let total = 0, healthy = 0, failed = 0, unknown = 0, degraded = 0;
    for (const row of rows as any[]) {
      total += row.cnt;
      if (row.health_state === 'HEALTHY') healthy += row.cnt;
      else if (row.health_state === 'FAILED') failed += row.cnt;
      else if (row.health_state === 'UNKNOWN') unknown += row.cnt;
      else if (row.health_state === 'DEGRADED') degraded += row.cnt;
    }
    if (total === 0) return 'UNKNOWN';
    if (failed > 0 || unknown > 0) return 'FAILED';
    if (degraded > 0) return 'DEGRADED';
    return 'HEALTHY';
  }

  async calculateGlobalCapacity(): Promise<{ total: number; available: number; reserved: number; utilization: number }> {
    const rows = await this.db.all(
      `SELECT tc.entity_id, tc.total_capacity, tc.available_capacity, tc.reserved_capacity
       FROM topology_capacity tc
       JOIN global_topology gt ON tc.entity_id = gt.id
       WHERE gt.node_type != 'global'`
    );
    const latestMap = new Map<string, { total_capacity: number; available_capacity: number; reserved_capacity: number }>();
    for (const row of rows as any[]) {
      latestMap.set(row.entity_id, row);
    }
    let total = 0, available = 0, reserved = 0;
    for (const val of latestMap.values()) {
      total += val.total_capacity;
      available += val.available_capacity;
      reserved += val.reserved_capacity;
    }
    const utilization = total > 0 ? ((total - available) / total) * 100 : 0;
    return { total, available, reserved, utilization };
  }

  // ========== Failure Detection and Recovery Planning ==========
  async detectFailure(input: {
    scope: string;
    entity_id: string;
    description: string;
    correlation_id?: string;
  }): Promise<{ incident_id: string; failure_domain_id: string }> {
    const correlationId = input.correlation_id ?? uuidv4();
    const fdId = uuidv4();
    await this.db.run(
      `INSERT INTO failure_domains (id, scope, entity_id, state, detected_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state = 'FAILED', detected_at = datetime('now'), resolved_at = NULL`,
      [fdId, input.scope, input.entity_id, 'FAILED']
    );
    const incidentId = uuidv4();
    await this.db.run(
      `INSERT INTO topology_incidents (id, severity, description, affected_scope, correlation_id)
       VALUES (?,?,?,?,?)`,
      [incidentId, 'HIGH', input.description, JSON.stringify({ scope: input.scope, entity_id: input.entity_id }), correlationId]
    );
    return { incident_id: incidentId, failure_domain_id: fdId };
  }

  async createRecoveryPlan(input: {
    incident_id: string;
    affected_scope: Record<string, any>;
    workloads: any[];
    dependencies: any[];
    source_domain: string;
    target_domain: string;
    required_capacity: Record<string, any>;
    required_approvals: any[];
    required_safety_gates: any[];
    rollback_path: any;
    verification_strategy: any;
  }): Promise<string> {
    const planId = uuidv4();
    await this.db.run(
      `INSERT INTO recovery_plans (id, incident_id, affected_scope, workloads, dependencies, source_domain, target_domain,
        required_capacity, required_approvals, required_safety_gates, rollback_path, verification_strategy, state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT')`,
      [planId, input.incident_id, JSON.stringify(input.affected_scope), JSON.stringify(input.workloads), JSON.stringify(input.dependencies),
       input.source_domain, input.target_domain, JSON.stringify(input.required_capacity), JSON.stringify(input.required_approvals),
       JSON.stringify(input.required_safety_gates), JSON.stringify(input.rollback_path), JSON.stringify(input.verification_strategy)]
    );
    return planId;
  }

  // ========== Safety and Governance Evaluation ==========
  async evaluateGovernance(action: string, entityId: string, context: Record<string, any>): Promise<'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE'> {
    const node = await this.db.get('SELECT governance_state FROM global_topology WHERE id = ?', [entityId]);
    if (!node) return 'DENY';
    if (node.governance_state === 'DENY') return 'DENY';
    if (node.governance_state === 'FREEZE') return 'FREEZE';
    if (['FAILOVER', 'FAILBACK', 'DISASTER_RECOVERY'].includes(action)) return 'APPROVAL_REQUIRED';
    return 'ALLOW';
  }

  async evaluateSafety(input: {
    action: string;
    source_id: string;
    target_id: string;
    project?: string;
    environment?: string;
    blast_radius?: number;
  }): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const source = await this.db.get('SELECT * FROM global_topology WHERE id = ?', [input.source_id]);
    const target = await this.db.get('SELECT * FROM global_topology WHERE id = ?', [input.target_id]);
    if (!source || !target) reasons.push('Invalid source or target');
    if (target?.health_state === 'FAILED' || target?.health_state === 'QUARANTINED') reasons.push('Target is failed/quarantined');
    const cap = await this.db.get('SELECT available_capacity FROM topology_capacity WHERE entity_id = ? ORDER BY observed_at DESC LIMIT 1', [input.target_id]);
    if (cap && cap.available_capacity <= 0) reasons.push('Target has no available capacity');
    if (input.blast_radius !== undefined && input.blast_radius > 10) reasons.push('Blast radius exceeds policy limit');
    const split = await this.db.get('SELECT COUNT(*) as cnt FROM split_brain_events WHERE resolved = false');
    if (split && split.cnt > 0) reasons.push('Active split-brain condition');
    return { safe: reasons.length === 0, reasons };
  }

  // ========== Reservations ==========
  async reserveRecoveryCapacity(input: {
    entity_id: string;
    capacity_reserved: number;
    operation_type: 'FAILOVER' | 'FAILBACK' | 'MIGRATION' | 'RECOVERY';
    operation_id: string;
    expires_in_seconds?: number;
  }): Promise<string> {
    const expires = new Date(Date.now() + (input.expires_in_seconds ?? 300) * 1000).toISOString();
    const cap = await this.db.get('SELECT available_capacity FROM topology_capacity WHERE entity_id = ? ORDER BY observed_at DESC LIMIT 1', [input.entity_id]);
    if (!cap || cap.available_capacity < input.capacity_reserved) throw new Error('Insufficient capacity for reservation');
    const existing = await this.db.get("SELECT id FROM recovery_reservations WHERE entity_id = ? AND operation_id = ? AND expires_at > datetime('now')", [input.entity_id, input.operation_id]);
    if (existing) throw new Error('Duplicate active reservation');
    const id = uuidv4();
    try {
      await this.db.run(
        `INSERT INTO recovery_reservations (id, entity_id, capacity_reserved, operation_type, operation_id, expires_at)
         VALUES (?,?,?,?,?,?)`,
        [id, input.entity_id, input.capacity_reserved, input.operation_type, input.operation_id, expires]
      );
    } catch (e: any) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        throw new Error('Duplicate active reservation');
      }
      throw e;
    }
    await this.db.run(
      `UPDATE topology_capacity SET available_capacity = available_capacity - ?, reserved_capacity = reserved_capacity + ? WHERE entity_id = ? AND observed_at = (SELECT MAX(observed_at) FROM topology_capacity WHERE entity_id = ?)`,
      [input.capacity_reserved, input.capacity_reserved, input.entity_id, input.entity_id]
    );
    return id;
  }

  // ========== Failover / Failback ==========
  async executeFailover(input: {
    plan_id: string;
    source_id: string;
    target_id: string;
    approval_id?: string;
    correlation_id?: string;
  }): Promise<{ operation_id: string; state: string }> {
    const correlationId = input.correlation_id ?? uuidv4();
    const gov = await this.evaluateGovernance('FAILOVER', input.source_id, { target: input.target_id });
    if (gov !== 'ALLOW' && gov !== 'APPROVAL_REQUIRED') throw new Error(`Governance denied: ${gov}`);
    if (gov === 'APPROVAL_REQUIRED' && !input.approval_id) throw new Error('Approval required for failover');
    const safety = await this.evaluateSafety({ action: 'FAILOVER', source_id: input.source_id, target_id: input.target_id });
    if (!safety.safe) throw new Error(`Safety check failed: ${safety.reasons.join(', ')}`);
    const reservationId = await this.reserveRecoveryCapacity({
      entity_id: input.target_id,
      capacity_reserved: 1,
      operation_type: 'FAILOVER',
      operation_id: uuidv4()
    });
    const existingOp = await this.db.get('SELECT id FROM failover_operations WHERE plan_id = ? AND source_id = ? AND target_id = ?', [input.plan_id, input.source_id, input.target_id]);
    if (existingOp) throw new Error('Duplicate active reservation');
    const opId = uuidv4();
    try {
      await this.db.run(
        `INSERT INTO failover_operations (id, plan_id, source_id, target_id, state, approval_id, reservation_id, correlation_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [opId, input.plan_id, input.source_id, input.target_id, 'RESERVED', input.approval_id, reservationId, correlationId]
      );
    } catch (e: any) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        throw new Error('Duplicate active reservation');
      }
      throw e;
    }
    await this.db.run('UPDATE global_topology SET lifecycle_state = ? WHERE id = ?', ['DRAINING', input.source_id]);
    return { operation_id: opId, state: 'RESERVED' };
  }

  async executeFailback(input: {
    plan_id: string;
    source_id: string;
    target_id: string;
    approval_id?: string;
    correlation_id?: string;
  }): Promise<{ operation_id: string; state: string }> {
    const correlationId = input.correlation_id ?? uuidv4();
    const gov = await this.evaluateGovernance('FAILBACK', input.source_id, { target: input.target_id });
    if (gov !== 'ALLOW' && gov !== 'APPROVAL_REQUIRED') throw new Error(`Governance denied: ${gov}`);
    if (gov === 'APPROVAL_REQUIRED' && !input.approval_id) throw new Error('Approval required for failback');
    const safety = await this.evaluateSafety({ action: 'FAILBACK', source_id: input.source_id, target_id: input.target_id });
    if (!safety.safe) throw new Error(`Safety check failed: ${safety.reasons.join(', ')}`);
    const reservationId = await this.reserveRecoveryCapacity({
      entity_id: input.target_id,
      capacity_reserved: 1,
      operation_type: 'FAILBACK',
      operation_id: uuidv4()
    });
    const existingOp = await this.db.get('SELECT id FROM failback_operations WHERE plan_id = ? AND source_id = ? AND target_id = ?', [input.plan_id, input.source_id, input.target_id]);
    if (existingOp) throw new Error('Duplicate active reservation');
    const opId = uuidv4();
    try {
      await this.db.run(
        `INSERT INTO failback_operations (id, plan_id, source_id, target_id, state, approval_id, reservation_id, correlation_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [opId, input.plan_id, input.source_id, input.target_id, 'RESERVED', input.approval_id, reservationId, correlationId]
      );
    } catch (e: any) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        throw new Error('Duplicate active reservation');
      }
      throw e;
    }
    return { operation_id: opId, state: 'RESERVED' };
  }

  // ========== Workload Migration ==========
  async migrateWorkload(input: {
    workload_id: string;
    source_domain: string;
    target_domain: string;
    idempotency_key: string;
    ownership: Record<string, any>;
    correlation_id?: string;
  }): Promise<string> {
    const correlationId = input.correlation_id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM workload_migrations WHERE workload_id = ? AND idempotency_key = ?', [input.workload_id, input.idempotency_key]);
    if (existing) return existing.id;
    const target = await this.db.get('SELECT id, health_state FROM global_topology WHERE id = ?', [input.target_domain]);
    if (!target || target.health_state !== 'HEALTHY') throw new Error('Target domain not healthy');
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO workload_migrations (id, workload_id, source_domain, target_domain, state, idempotency_key, ownership, correlation_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.workload_id, input.source_domain, input.target_domain, 'PLANNED', input.idempotency_key, JSON.stringify(input.ownership), correlationId]
    );
    return id;
  }

  // ========== Draining ==========
  async drainFailureDomain(entity_id: string): Promise<void> {
    await this.db.run("UPDATE global_topology SET lifecycle_state = 'DRAINING', updated_at = datetime('now') WHERE id = ?", [entity_id]);
  }

  // ========== Consistency and Split-Brain ==========
  async detectConsistencyConflict(input: {
    entity_type: string;
    entity_id: string;
    conflict_type: 'STALE_STATE' | 'CONFLICTING_STATE' | 'DIVERGENT_STATE' | 'MISSING_STATE' | 'DUPLICATE_STATE' | 'SPLIT_BRAIN' | 'REPLAY_DIVERGENCE' | 'TOPOLOGY_DIVERGENCE';
    description: string;
    correlation_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO consistency_conflicts (id, entity_type, entity_id, conflict_type, description, correlation_id)
       VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.conflict_type, input.description, input.correlation_id ?? uuidv4()]
    );
    return id;
  }

  async detectSplitBrain(input: {
    entity_type: string;
    entity_id: string;
    description: string;
    correlation_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO split_brain_events (id, entity_type, entity_id, description, correlation_id)
       VALUES (?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.description, input.correlation_id ?? uuidv4()]
    );
    return id;
  }

  // ========== Leadership Epoch ==========
  async acquireControlEpoch(controller_id: string, lease_seconds: number = 300): Promise<number> {
    const epochId = uuidv4();
    const epoch = Math.max(Date.now(), this.lastEpoch + 1);
    this.lastEpoch = epoch;
    const expires = new Date(Date.now() + lease_seconds * 1000).toISOString();
    await this.db.run(
      `INSERT INTO control_plane_epochs (id, controller_id, epoch, leadership_lease, expires_at)
       VALUES (?,?,?,?,?)`,
      [epochId, controller_id, epoch, JSON.stringify({ lease_start: new Date().toISOString(), lease_end: expires }), expires]
    );
    return epoch;
  }

  async fenceStaleController(epoch: number): Promise<void> {
    await this.db.run('UPDATE control_plane_epochs SET fenced = true WHERE epoch < ?', [epoch]);
  }

  // ========== Circuit Breakers ==========
  async openGlobalCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO global_circuit_breakers (id, scope, entity_id, state, opened_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state = 'OPEN', opened_at = datetime('now'), closed_at = NULL`,
      [uuidv4(), scope, entity_id, 'OPEN']
    );
  }

  async closeGlobalCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO global_circuit_breakers (id, scope, entity_id, state, closed_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state = 'CLOSED', closed_at = datetime('now')`,
      [uuidv4(), scope, entity_id, 'CLOSED']
    );
  }

  // ========== Evidence, Audit, Lineage, Learning ==========
  async generateTopologyEvidence(input: {
    entity_type: string;
    entity_id: string;
    evidence_type: string;
    data: Record<string, any>;
    correlation_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO topology_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id)
       VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), input.correlation_id ?? uuidv4()]
    );
    return id;
  }

  async recordTopologyAudit(input: {
    entity_type: string;
    entity_id: string;
    actor: string;
    previous_state: any;
    new_state: any;
    reason: string;
    correlation_id?: string;
    control_plane_epoch: number;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO topology_audit (id, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, control_plane_epoch)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state), JSON.stringify(input.new_state), input.reason, input.correlation_id ?? uuidv4(), input.control_plane_epoch]
    );
    return id;
  }

  async recordTopologyLineage(input: {
    entity_type: string;
    entity_id: string;
    phase: string;
    data: Record<string, any>;
    correlation_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO topology_lineage (id, entity_type, entity_id, phase, data, correlation_id)
       VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), input.correlation_id ?? uuidv4()]
    );
    return id;
  }

  async recordTopologyLearning(input: {
    learning_type: string;
    entity_id: string;
    data: Record<string, any>;
    correlation_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO topology_learning (id, learning_type, entity_id, data, correlation_id)
       VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), input.correlation_id ?? uuidv4()]
    );
    return id;
  }

  // ========== Deterministic Replay Helpers ==========
  deterministicFingerprint(decisionState: Record<string, any>): string {
    const str = JSON.stringify(decisionState);
    return createHash('sha256').update(str).digest('hex');
  }

  async replayGlobalOrchestration(decisionState: Record<string, any>): Promise<{ fingerprint: string; expected: string | null; match: boolean }> {
    const fp = this.deterministicFingerprint(decisionState);
    const stored = await this.db.get('SELECT fingerprint FROM replay_fingerprints WHERE decision_key = ?', [decisionState.decision_key]);
    const expected = stored?.fingerprint ?? null;
    return { fingerprint: fp, expected, match: expected === null ? true : expected === fp };
  }
}