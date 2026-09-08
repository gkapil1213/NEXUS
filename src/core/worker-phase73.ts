// src/core/worker-phase73.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type RegionHealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'FENCED';
export type MembershipStatus = 'JOINING' | 'ACTIVE' | 'SUSPECTED' | 'FENCED' | 'LEAVING' | 'REMOVED';
export type PlacementState = 'PLANNED' | 'RESERVED' | 'DISPATCHED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'HALTED' | 'FAILOVER_PENDING' | 'FAILOVER_DISPATCHED' | 'VERIFIED' | 'REGRESSED' | 'QUARANTINED' | 'CANCELLED';

export class Phase73ControlPlane {
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

  private nextEpoch(): number {
    this.lastEpoch = Math.max(Date.now(), this.lastEpoch + 1);
    return this.lastEpoch;
  }

  // ========== Region Management ==========
  async registerRegion(input: {
    id: string;
    provider: string;
    geography: string;
    control_plane_endpoint: string;
    execution_endpoint: string;
    failure_domain: string;
    active_standby_capability?: string;
    supported_environments?: string[];
    protection_level?: string;
    governance_state?: string;
  }): Promise<void> {
    const existing = await this.db.get('SELECT id FROM regions WHERE id = ?', [input.id]);
    if (existing) return;
    await this.db.run(
      `INSERT INTO regions (id, provider, geography, control_plane_endpoint, execution_endpoint, failure_domain, active_standby_capability, supported_environments, protection_level, governance_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.provider,
        input.geography,
        input.control_plane_endpoint,
        input.execution_endpoint,
        input.failure_domain,
        input.active_standby_capability ?? 'ACTIVE',
        JSON.stringify(input.supported_environments ?? []),
        input.protection_level ?? 'STANDARD',
        input.governance_state ?? 'ALLOW'
      ]
    );
  }

  async getRegion(regionId: string): Promise<any> {
    return this.db.get('SELECT * FROM regions WHERE id = ?', [regionId]);
  }

  // ========== Membership ==========
  async registerControlPlaneMember(input: {
    id: string;
    region_id: string;
    instance_identity: string;
    capabilities?: string[];
  }): Promise<void> {
    const region = await this.db.get('SELECT id FROM regions WHERE id = ?', [input.region_id]);
    if (!region) throw new Error('Region not found');
    const existing = await this.db.get('SELECT id FROM control_plane_members WHERE id = ?', [input.id]);
    if (existing) return;
    await this.db.run(
      `INSERT INTO control_plane_members (id, region_id, instance_identity, status, capabilities)
       VALUES (?,?,?,?,?)`,
      [input.id, input.region_id, input.instance_identity, 'JOINING', JSON.stringify(input.capabilities ?? [])]
    );
  }

  async heartbeatMember(memberId: string): Promise<void> {
    await this.db.run(
      `UPDATE control_plane_members SET updated_at = datetime('now'), status = CASE WHEN status = 'JOINING' THEN 'ACTIVE' ELSE status END WHERE id = ?`,
      [memberId]
    );
  }

  // ========== Region Health ==========
  async observeRegionHealth(input: {
    region_id: string;
    control_plane_health: string;
    worker_health: string;
    provider_health: string;
    network_health: string;
    storage_health: string;
    execution_health: string;
    dependency_health: string;
    capacity?: number;
    active_workload_count?: number;
    queue_depth?: number;
    error_rate?: number;
    recovery_state?: string;
    circuit_breaker_state?: string;
    correlation_id?: string;
  }): Promise<void> {
    const region = await this.db.get('SELECT id FROM regions WHERE id = ?', [input.region_id]);
    if (!region) throw new Error('Region not found');
    const correlationId = input.correlation_id ?? uuidv4();
    await this.db.run(
      `INSERT INTO region_health (id, region_id, control_plane_health, worker_health, provider_health, network_health, storage_health, execution_health, dependency_health, capacity, active_workload_count, queue_depth, error_rate, recovery_state, circuit_breaker_state, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), input.region_id, input.control_plane_health, input.worker_health, input.provider_health, input.network_health, input.storage_health, input.execution_health, input.dependency_health,
       input.capacity ?? 0, input.active_workload_count ?? 0, input.queue_depth ?? 0, input.error_rate ?? 0, input.recovery_state ?? 'NONE', input.circuit_breaker_state ?? 'CLOSED', correlationId]
    );
    const health = this.classifyHealth(input);
    await this.db.run(`UPDATE regions SET health = ?, updated_at = datetime('now') WHERE id = ?`, [health, input.region_id]);
  }

  private classifyHealth(h: any): RegionHealthState {
    const checks = [h.control_plane_health, h.worker_health, h.provider_health, h.network_health, h.storage_health, h.execution_health, h.dependency_health];
    if (checks.some(c => c === 'UNHEALTHY' || c === 'FAILED')) return 'UNHEALTHY';
    if (checks.some(c => c === 'DEGRADED')) return 'DEGRADED';
    if (checks.every(c => c === 'HEALTHY')) return 'HEALTHY';
    return 'UNKNOWN';
  }

  // ========== Quorum & Coordinator ==========
  async calculateQuorum(): Promise<{ total: number; active: number; required: number; state: string }> {
    const total = (await this.db.get('SELECT COUNT(*) as cnt FROM control_plane_members'))?.cnt ?? 0;
    const active = (await this.db.get("SELECT COUNT(*) as cnt FROM control_plane_members WHERE status = 'ACTIVE'"))?.cnt ?? 0;
    const required = Math.floor(total / 2) + 1;
    let state = active >= required ? 'AVAILABLE' : 'LOST';
    await this.db.run(`INSERT INTO quorum_states (id, total_members, active_members, required_quorum, state) VALUES (?,?,?,?,?)`, [uuidv4(), total, active, required, state]);
    return { total, active, required, state };
  }

  async electCoordinator(region_id: string, member_id: string): Promise<{ epoch: number; coordinator_id: string }> {
    const quorum = await this.calculateQuorum();
    if (quorum.state !== 'AVAILABLE') throw new Error('Quorum unavailable for election');
    const epoch = this.nextEpoch();
    const leaseExpires = new Date(Date.now() + 300000).toISOString();
    await this.db.run(`INSERT INTO coordinator_epochs (id, epoch, coordinator_id, lease_expires_at) VALUES (?,?,?,?)`, [uuidv4(), epoch, member_id, leaseExpires]);
    return { epoch, coordinator_id: member_id };
  }

  async renewCoordinatorLease(epoch: number): Promise<void> {
    const record = await this.db.get('SELECT * FROM coordinator_epochs WHERE epoch = ?', [epoch]);
    if (!record || record.fenced) throw new Error('Invalid or fenced epoch');
    const member = await this.db.get('SELECT status FROM control_plane_members WHERE id = ?', [record.coordinator_id]);
    if (member && member.status === 'FENCED') throw new Error('Invalid or fenced epoch');
    const newExpiry = new Date(Date.now() + 300000).toISOString();
    await this.db.run(`UPDATE coordinator_epochs SET lease_expires_at = ? WHERE epoch = ?`, [newExpiry, epoch]);
  }

  async fenceMember(member_id: string, reason: string): Promise<void> {
    const member = await this.db.get('SELECT region_id FROM control_plane_members WHERE id = ?', [member_id]);
    const region_id = member?.region_id ?? '';
    await this.db.run(`UPDATE control_plane_members SET status = 'FENCED', fencing_state = 'FENCED' WHERE id = ?`, [member_id]);
    await this.db.run(`INSERT INTO fencing_records (id, region_id, member_id, fence_reason, fence_epoch, fence_state, correlation_id) VALUES (?,?,?,?,?,?,?)`, [uuidv4(), region_id, member_id, reason, this.nextEpoch(), 'FENCED', uuidv4()]);
  }

  async unfenceRegion(region_id: string): Promise<void> {
    const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [region_id]);
    if (!region) throw new Error('Region not found');
    const latestHealth = await this.db.get('SELECT * FROM region_health WHERE region_id = ? ORDER BY observed_at DESC LIMIT 1', [region_id]);
    if (!latestHealth) throw new Error('No health observation for region');
    const health = this.classifyHealth(latestHealth);
    if (health !== 'HEALTHY') throw new Error('Region not healthy; cannot unfence');
    await this.db.run(`UPDATE regions SET health = 'HEALTHY', availability_state = 'ACTIVE' WHERE id = ?`, [region_id]);
  }

  // ========== Placement ==========
  async evaluatePlacement(input: {
    workload_id: string;
    project_id: string;
    environment: string;
    preferred_regions?: string[];
    allowed_regions?: string[];
    excluded_regions?: string[];
    required_capacity?: number;
    region_requirements?: any;
  }): Promise<{ region_id: string; placement_id: string }> {
    const regions = await this.db.all('SELECT * FROM regions');
    if (!regions.length) throw new Error('No regions available');
    let candidates: any[] = regions;
    if (input.allowed_regions && input.allowed_regions.length) candidates = candidates.filter(r => input.allowed_regions!.includes(r.id));
    if (input.excluded_regions && input.excluded_regions.length) candidates = candidates.filter(r => !input.excluded_regions!.includes(r.id));
    if (candidates.length === 0) throw new Error('No allowed regions');
    candidates = candidates.filter(r => r.health === 'HEALTHY');
    if (candidates.length === 0) throw new Error('No healthy regions');
    if (input.preferred_regions && input.preferred_regions.length) {
      const pref = input.preferred_regions;
      candidates.sort((a, b) => {
        const ia = pref.indexOf(a.id);
        const ib = pref.indexOf(b.id);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.id.localeCompare(b.id);
      });
    } else {
      candidates.sort((a, b) => a.id.localeCompare(b.id));
    }
    const chosen = candidates[0];
    if (!chosen) throw new Error('No region selected');
    const placementId = uuidv4();
    await this.db.run(`INSERT INTO global_placements (id, workload_id, project_id, environment, region_id, placement_state, placement_epoch) VALUES (?,?,?,?,?,?,?)`, [placementId, input.workload_id, input.project_id, input.environment, chosen.id, 'PLANNED', this.nextEpoch()]);
    return { region_id: chosen.id, placement_id: placementId };
  }

  // ========== Reservations ==========
  async reserveGlobalCapacity(input: { region_id: string; workload_id: string; capacity_reserved: number; epoch: number; expires_in_seconds?: number }): Promise<string> {
    const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.region_id]);
    if (!region) throw new Error('Region not found');
    if (region.health !== 'HEALTHY') throw new Error('Region not healthy');
    const cap = await this.db.get('SELECT available_capacity FROM region_capacities WHERE region_id = ? ORDER BY observed_at DESC LIMIT 1', [input.region_id]);
    if (cap && cap.available_capacity < input.capacity_reserved) throw new Error('Insufficient capacity');
    const existing = await this.db.get('SELECT id FROM global_reservations WHERE region_id = ? AND workload_id = ?', [input.region_id, input.workload_id]);
    if (existing) throw new Error('Duplicate reservation');
    const id = uuidv4();
    const expires = new Date(Date.now() + (input.expires_in_seconds ?? 300) * 1000).toISOString();
    await this.db.run(`INSERT INTO global_reservations (id, region_id, workload_id, capacity_reserved, expires_at, epoch) VALUES (?,?,?,?,?,?)`, [id, input.region_id, input.workload_id, input.capacity_reserved, expires, input.epoch]);
    return id;
  }

  async releaseGlobalReservation(reservation_id: string): Promise<void> {
    await this.db.run(`UPDATE global_reservations SET reservation_state = 'RELEASED' WHERE id = ?`, [reservation_id]);
  }

  // ========== Dispatch ==========
  async dispatchGlobalWorkload(input: { workload_id: string; region_id: string; placement_id: string; epoch: number }): Promise<{ dispatch_id: string; state: PlacementState }> {
    const placement = await this.db.get('SELECT * FROM global_placements WHERE id = ?', [input.placement_id]);
    if (!placement) throw new Error('Placement not found');
    if (placement.placement_state !== 'PLANNED' && placement.placement_state !== 'RESERVED') throw new Error('Invalid placement state for dispatch');
    await this.db.run(`UPDATE global_placements SET placement_state = 'DISPATCHED' WHERE id = ?`, [input.placement_id]);
    return { dispatch_id: uuidv4(), state: 'DISPATCHED' };
  }

  // ========== Failover ==========
  async failoverWorkload(input: { workload_id: string; source_region_id: string; target_region_id: string; epoch: number }): Promise<{ failover_id: string; state: string }> {
    const existing = await this.db.get("SELECT * FROM regional_failovers WHERE workload_id = ? AND failover_state NOT IN ('COMPLETED','CANCELLED')", [input.workload_id]);
    if (existing) throw new Error('Duplicate failover in progress');
    const target = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.target_region_id]);
    if (!target || target.health !== 'HEALTHY') throw new Error('Target region not healthy');
    const failoverId = uuidv4();
    await this.db.run(`INSERT INTO regional_failovers (id, workload_id, source_region_id, target_region_id, failover_state, failover_epoch) VALUES (?,?,?,?,?,?)`, [failoverId, input.workload_id, input.source_region_id, input.target_region_id, 'PLANNED', input.epoch]);
    return { failover_id: failoverId, state: 'PLANNED' };
  }

  // ========== Evacuation ==========
  async evacuateRegion(input: { region_id: string; reason: string; epoch: number }): Promise<{ evacuation_id: string; state: string }> {
    const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.region_id]);
    if (!region) throw new Error('Region not found');
    const evacId = uuidv4();
    await this.db.run(`INSERT INTO region_evacuations (id, region_id, evacuation_state, dispatch_freeze) VALUES (?,?,?,1)`, [evacId, input.region_id, 'REQUESTED']);
    return { evacuation_id: evacId, state: 'REQUESTED' };
  }

  // ========== Reconciliation ==========
  async reconcileRegions(input: { region_id: string; expected_workloads?: string[] }): Promise<{ reconciliation_id: string; conflicts: string[] }> {
    const conflicts: string[] = [];
    const placements = await this.db.all('SELECT * FROM global_placements WHERE region_id = ?', [input.region_id]);
    if (input.expected_workloads) {
      for (const wl of input.expected_workloads) {
        const exists = placements.some((p: any) => p.workload_id === wl);
        if (!exists) conflicts.push(`Missing workload ${wl}`);
      }
    }
    const recId = uuidv4();
    await this.db.run(`INSERT INTO reconciliation_records (id, region_id, conflict_type, description, reconciliation_decision, correlation_id) VALUES (?,?,?,?,?,?)`, [recId, input.region_id, 'RECONCILIATION', JSON.stringify(conflicts), conflicts.length ? 'MANUAL_REVIEW' : 'NO_CONFLICT', uuidv4()]);
    return { reconciliation_id: recId, conflicts };
  }

  // ========== Governance & Safety ==========
  async evaluateGlobalGovernance(input: { action: string; region_id: string; project_id?: string; environment?: string }): Promise<'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE'> {
    const region = await this.db.get('SELECT governance_state FROM regions WHERE id = ?', [input.region_id]);
    if (!region) return 'DENY';
    if (region.governance_state === 'DENY') return 'DENY';
    if (region.governance_state === 'FREEZE') return 'FREEZE';
    if (['FAILOVER', 'EVACUATION'].includes(input.action)) return 'APPROVAL_REQUIRED';
    return 'ALLOW';
  }

  async evaluateGlobalSafety(input: { action: string; region_id?: string; workload_id?: string; epoch?: number; blast_radius?: number }): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (input.region_id) {
      const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.region_id]);
      if (!region) reasons.push('Unknown region');
      else if (region.health === 'UNHEALTHY' || region.health === 'FENCED') reasons.push('Unhealthy or fenced region');
      else if (region.health === 'UNKNOWN') reasons.push('Unknown health');
      const latestHealth = await this.db.get('SELECT observed_at FROM region_health WHERE region_id = ? ORDER BY observed_at DESC LIMIT 1', [input.region_id]);
      if (!latestHealth) reasons.push('No health observation');
      else if (Date.now() - new Date(latestHealth.observed_at).getTime() > 600000) reasons.push('Stale health');
    }
    if (input.epoch !== undefined) {
      const epochRecord = await this.db.get('SELECT * FROM coordinator_epochs WHERE epoch = ?', [input.epoch]);
      if (!epochRecord || epochRecord.fenced) reasons.push('Stale or fenced epoch');
    }
    if (input.blast_radius !== undefined && input.blast_radius > 10) reasons.push('Blast radius exceeds policy');
    return { safe: reasons.length === 0, reasons };
  }

  // ========== Approvals ==========
  async requestGlobalApproval(input: { action: string; workload_id?: string; source_region_id?: string; target_region_id?: string; epoch: number; requested_by: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, region_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uuidv4(), 'APPROVAL_REQUESTED', 'GLOBAL_APPROVAL', id, input.requested_by, null, null, input.action, uuidv4(), input.source_region_id ?? input.target_region_id, input.epoch]);
    return id;
  }

  async approveFailover(approval_id: string, epoch: number): Promise<void> {
    await this.db.run(`INSERT INTO phase73_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`, [uuidv4(), 'APPROVAL_GRANTED', 'GLOBAL_APPROVAL', approval_id, 'system', null, null, 'Approved', uuidv4(), epoch]);
  }

  async rejectFailover(approval_id: string, epoch: number): Promise<void> {
    await this.db.run(`INSERT INTO phase73_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`, [uuidv4(), 'APPROVAL_REJECTED', 'GLOBAL_APPROVAL', approval_id, 'system', null, null, 'Rejected', uuidv4(), epoch]);
  }

  async verifyFailover(failover_id: string): Promise<void> {
    await this.db.run(`UPDATE regional_failovers SET verification_state = 'VERIFIED', failover_state = 'COMPLETED' WHERE id = ?`, [failover_id]);
  }

  // ========== Incidents ==========
  async createGlobalIncident(input: { incident_type: string; description: string; severity?: string; affected_region_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_incidents (id, severity, description, affected_region_id, incident_type, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.severity ?? 'MEDIUM', input.description, input.affected_region_id, input.incident_type, uuidv4()]);
    return id;
  }

  async escalateGlobalIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE phase73_incidents SET escalated = 1 WHERE id = ?`, [incident_id]);
  }

  // ========== Evidence/Audit/Lineage/Learning ==========
  async generateGlobalEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; region_id?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, region_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.region_id ?? null, input.epoch]);
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO phase73_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  // ========== Replay ==========
  async replayGlobalDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}