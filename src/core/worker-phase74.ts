// src/core/worker-phase74.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type OptimizationState = 'PROPOSED' | 'EVALUATED' | 'BLOCKED' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'RESERVED' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'REGRESSED' | 'CANCELLED';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';

export interface CapacityInput {
  region_id: string;
  fleet_id?: string;
  project_id?: string;
  environment?: string;
  capacity_type: string;
  total: number;
  allocated: number;
  reserved: number;
  active: number;
  available: number;
  degraded?: number;
  unavailable?: number;
  source: string;
  correlation_id?: string;
}

export interface DemandInput {
  workload_id: string;
  project_id: string;
  environment: string;
  cpu_requirement?: number;
  memory_requirement?: number;
  execution_slots?: number;
  concurrency?: number;
  provider_requirements?: string[];
  capability_requirements?: string[];
  latency_sensitivity?: string;
  deadline?: string;
  availability_requirement?: string;
  region_affinity?: string[];
  region_exclusions?: string[];
  environment_requirements?: string[];
  project_constraints?: string[];
  migration_tolerance?: boolean;
  interruption_tolerance?: boolean;
  estimated_duration?: number;
}

export interface OptimizationRequest {
  workload_id: string;
  project_id: string;
  environment: string;
  objectives?: string[];
  preferred_regions?: string[];
  excluded_regions?: string[];
  required_capacity?: number;
  capacity_type?: string;
  blast_radius?: number;
  epoch?: number;
}

export class Phase74ControlPlane {
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

  private currentEpoch(): number {
    return this.lastEpoch || Date.now();
  }

  // ========== Capacity ==========
  async observeCapacity(input: CapacityInput): Promise<string> {
    const id = uuidv4();
    const correlationId = input.correlation_id ?? uuidv4();
    await this.db.run(
      `INSERT INTO capacity_observations (id, region_id, fleet_id, project_id, environment, capacity_type, total, allocated, reserved, active, available, degraded, unavailable, observed_at, source, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.region_id, input.fleet_id ?? null, input.project_id ?? null, input.environment ?? null, input.capacity_type, input.total, input.allocated, input.reserved, input.active, input.available, input.degraded ?? 0, input.unavailable ?? 0, new Date().toISOString(), input.source, correlationId]
    );
    // Update or insert into capacity_models latest snapshot
    await this.db.run(
      `INSERT INTO capacity_models (id, region_id, fleet_id, project_id, environment, capacity_type, total, allocated, reserved, active, available, degraded, unavailable, observed_at, source, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(region_id, fleet_id, project_id, environment, capacity_type, observed_at) DO UPDATE SET total=excluded.total, allocated=excluded.allocated, reserved=excluded.reserved, active=excluded.active, available=excluded.available, degraded=excluded.degraded, unavailable=excluded.unavailable, source=excluded.source, correlation_id=excluded.correlation_id`,
      [uuidv4(), input.region_id, input.fleet_id ?? null, input.project_id ?? null, input.environment ?? null, input.capacity_type, input.total, input.allocated, input.reserved, input.active, input.available, input.degraded ?? 0, input.unavailable ?? 0, new Date().toISOString(), input.source, correlationId]
    );
    return id;
  }

  async getLatestCapacity(region_id: string, capacity_type?: string): Promise<any> {
    const sql = capacity_type
      ? 'SELECT * FROM capacity_models WHERE region_id = ? AND capacity_type = ? ORDER BY observed_at DESC LIMIT 1'
      : 'SELECT * FROM capacity_models WHERE region_id = ? ORDER BY observed_at DESC LIMIT 1';
    return this.db.get(sql, capacity_type ? [region_id, capacity_type] : [region_id]);
  }

  // ========== Demand ==========
  async registerDemand(input: DemandInput): Promise<string> {
    const existing = await this.db.get('SELECT id FROM workload_demands WHERE workload_id = ?', [input.workload_id]);
    if (existing) return existing.id;
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO workload_demands (id, workload_id, project_id, environment, cpu_requirement, memory_requirement, execution_slots, concurrency, provider_requirements, capability_requirements, latency_sensitivity, deadline, availability_requirement, region_affinity, region_exclusions, environment_requirements, project_constraints, migration_tolerance, interruption_tolerance, estimated_duration)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.workload_id, input.project_id, input.environment, input.cpu_requirement ?? null, input.memory_requirement ?? null, input.execution_slots ?? null, input.concurrency ?? null,
       input.provider_requirements ? JSON.stringify(input.provider_requirements) : null,
       input.capability_requirements ? JSON.stringify(input.capability_requirements) : null,
       input.latency_sensitivity ?? null, input.deadline ?? null, input.availability_requirement ?? null,
       input.region_affinity ? JSON.stringify(input.region_affinity) : null,
       input.region_exclusions ? JSON.stringify(input.region_exclusions) : null,
       input.environment_requirements ? JSON.stringify(input.environment_requirements) : null,
       input.project_constraints ? JSON.stringify(input.project_constraints) : null,
       input.migration_tolerance ? 1 : 0, input.interruption_tolerance ? 1 : 0, input.estimated_duration ?? null]
    );
    return id;
  }

  async getDemand(workload_id: string): Promise<any> {
    return this.db.get('SELECT * FROM workload_demands WHERE workload_id = ?', [workload_id]);
  }

  // ========== Forecasting ==========
  async forecastCapacity(input: {
    region_id?: string;
    fleet_id?: string;
    project_id?: string;
    environment?: string;
    capacity_type?: string;
    horizon?: string;
    projected_demand: number;
    projected_available: number;
    confidence: number;
    assumptions?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO capacity_forecasts (id, region_id, fleet_id, project_id, environment, capacity_type, forecast_horizon, projected_demand, projected_available, confidence, assumptions, data_freshness, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.region_id ?? null, input.fleet_id ?? null, input.project_id ?? null, input.environment ?? null, input.capacity_type ?? null, input.horizon ?? 'short',
       input.projected_demand, input.projected_available, input.confidence, input.assumptions ?? null, 'current', uuidv4()]
    );
    return id;
  }

  // ========== Candidate Evaluation & Optimization ==========
  async evaluateCandidates(request: OptimizationRequest): Promise<any[]> {
    const demand = await this.getDemand(request.workload_id);
    if (!demand) throw new Error('Workload demand not found');
    const regions = await this.db.all('SELECT * FROM regions ORDER BY id');
    const candidates = [];
    for (const region of regions) {
      // Excluded regions
      if (request.excluded_regions && request.excluded_regions.includes(region.id)) continue;
      // Affinity preference
      if (request.preferred_regions && request.preferred_regions.includes(region.id)) region.affinity = 2;
      else region.affinity = 1;
      // Health check
      if (region.health !== 'HEALTHY') continue;
      // Capacity check
      const cap = await this.getLatestCapacity(region.id, request.capacity_type ?? 'execution_slots');
      if (cap) {
        if (request.required_capacity && cap.available < request.required_capacity) continue;
        region.available_capacity = cap.available;
      } else {
        region.available_capacity = undefined;
      }
      candidates.push(region);
    }
    return candidates;
  }

  async calculateOptimization(request: OptimizationRequest): Promise<{ decision_id: string; selected_region: string | null; score: number; confidence: number; rejected: any[] }> {
    const candidates = await this.evaluateCandidates(request);
    if (candidates.length === 0) {
      const decisionId = uuidv4();
      await this.db.run(`INSERT INTO optimization_decisions (id, workload_id, project_id, environment, region_id, placement_score, confidence, objectives, constraints, selected_candidate, rejected_candidates, reason, decision_state, decision_epoch, correlation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [decisionId, request.workload_id, request.project_id, request.environment, null, 0, 0, JSON.stringify(request.objectives ?? []), '[]', null, JSON.stringify([]), 'No eligible candidates', 'BLOCKED', this.nextEpoch(), uuidv4()]);
      return { decision_id: decisionId, selected_region: null, score: 0, confidence: 0, rejected: [] };
    }

    // Simple deterministic scoring: reliability (health) + affinity + capacity available
    const scored = candidates.map((c: any) => {
      let score = 0;
      if (c.health === 'HEALTHY') score += 50;
      if (c.affinity === 2) score += 20;
      if (c.available_capacity !== undefined) score += Math.min(c.available_capacity, 100) / 10;
      return { ...c, score };
    });
    scored.sort((a: any, b: any) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
    const selected = scored[0];
    const rejected = scored.slice(1);
    const decisionId = uuidv4();
    await this.db.run(`INSERT INTO optimization_decisions (id, workload_id, project_id, environment, region_id, placement_score, confidence, objectives, constraints, selected_candidate, rejected_candidates, reason, decision_state, decision_epoch, correlation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [decisionId, request.workload_id, request.project_id, request.environment, selected.id, selected.score, 0.8, JSON.stringify(request.objectives ?? []), '[]', JSON.stringify(selected.id), JSON.stringify(rejected.map((r:any)=>r.id)), 'Optimized', 'EVALUATED', this.nextEpoch(), uuidv4()]);
    return { decision_id: decisionId, selected_region: selected.id, score: selected.score, confidence: 0.8, rejected };
  }

  // ========== Placement ==========
  async selectPlacement(request: OptimizationRequest): Promise<{ placement_id: string; region_id: string; optimization_id: string }> {
    const decision = await this.calculateOptimization(request);
    if (!decision.selected_region) throw new Error('No eligible region');
    const placementId = uuidv4();
    await this.db.run(`INSERT INTO placement_decisions (id, optimization_id, workload_id, region_id, project_id, environment, placement_state, placement_epoch, correlation_id)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [placementId, decision.decision_id, request.workload_id, decision.selected_region, request.project_id, request.environment, 'PLANNED', this.currentEpoch(), uuidv4()]);
    return { placement_id: placementId, region_id: decision.selected_region, optimization_id: decision.decision_id };
  }

  // ========== Reservation ==========
  async reserveCapacity(input: { region_id: string; workload_id: string; project_id: string; environment: string; capacity_type: string; capacity_amount: number; epoch?: number }): Promise<string> {
    const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.region_id]);
    if (!region || region.health !== 'HEALTHY') throw new Error('Region not healthy');
    const cap = await this.getLatestCapacity(input.region_id, input.capacity_type);
    if (cap && cap.available < input.capacity_amount) throw new Error('Insufficient capacity');
    const existing = await this.db.get('SELECT id FROM optimization_reservations WHERE workload_id = ? AND region_id = ?', [input.workload_id, input.region_id]);
    if (existing) throw new Error('Duplicate reservation');
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_reservations (id, region_id, project_id, environment, workload_id, capacity_type, capacity_amount, epoch, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.region_id, input.project_id, input.environment, input.workload_id, input.capacity_type, input.capacity_amount, input.epoch ?? this.currentEpoch(), new Date(Date.now()+300000).toISOString()]);
    return id;
  }

  // ========== Steering / Migration ==========
  async createSteeringPlan(input: { workload_id: string; target_region_id: string; steering_type?: string; source_region_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO steering_plans (id, workload_id, source_region_id, target_region_id, steering_type, steering_state, epoch, correlation_id)
      VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.workload_id, input.source_region_id ?? null, input.target_region_id, input.steering_type ?? 'PREFERENCE', 'PROPOSED', this.nextEpoch(), uuidv4()]);
    return id;
  }

  async createMigrationPlan(input: { workload_id: string; source_region_id: string; target_region_id: string; reason?: string; rollback_plan?: string; verification_plan?: string }): Promise<string> {
    // Basic safety checks
    const target = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.target_region_id]);
    if (!target || target.health !== 'HEALTHY') throw new Error('Destination unhealthy');
    const cap = await this.getLatestCapacity(input.target_region_id);
    if (cap && cap.available <= 0) throw new Error('Destination capacity insufficient');
    const id = uuidv4();
    await this.db.run(`INSERT INTO migration_plans (id, workload_id, source_region_id, target_region_id, reason, rollback_plan, verification_plan, migration_state, epoch, correlation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.workload_id, input.source_region_id, input.target_region_id, input.reason ?? null, input.rollback_plan ?? null, input.verification_plan ?? null, 'PLANNED', this.nextEpoch(), uuidv4()]);
    return id;
  }

  async evaluateMigrationSafety(input: { migration_id: string }): Promise<{ safe: boolean; reasons: string[] }> {
    const plan = await this.db.get('SELECT * FROM migration_plans WHERE id = ?', [input.migration_id]);
    const reasons: string[] = [];
    if (!plan) reasons.push('Migration plan not found');
    else {
      const target = await this.db.get('SELECT * FROM regions WHERE id = ?', [plan.target_region_id]);
      if (!target || target.health !== 'HEALTHY') reasons.push('Destination unhealthy');
      const demand = await this.db.get('SELECT * FROM workload_demands WHERE workload_id = ?', [plan.workload_id]);
      if (demand && demand.region_exclusions) {
        const exclusions = JSON.parse(demand.region_exclusions);
        if (exclusions.includes(plan.target_region_id)) reasons.push('Destination excluded by workload');
      }
    }
    return { safe: reasons.length === 0, reasons };
  }

  // ========== Circuit Breakers ==========
  async openOptimizationCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO optimization_circuit_breakers (id, scope, entity_id, state, opened_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now'), closed_at=NULL`,
      [uuidv4(), scope, entity_id, 'OPEN']
    );
  }

  async closeOptimizationCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO optimization_circuit_breakers (id, scope, entity_id, state, closed_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'CLOSED']
    );
  }

  // ========== Governance & Safety ==========
  async evaluateGovernance(action: string, region_id: string, project_id?: string, environment?: string): Promise<GovernanceResult> {
    const region = await this.db.get('SELECT governance_state FROM regions WHERE id = ?', [region_id]);
    if (!region) return 'DENY';
    if (region.governance_state === 'DENY') return 'DENY';
    if (region.governance_state === 'FREEZE') return 'FREEZE';
    if (['MIGRATION','STEERING','FAILOVER'].includes(action)) return 'APPROVAL_REQUIRED';
    return 'ALLOW';
  }

  async evaluateSafety(input: { region_id?: string; epoch?: number; blast_radius?: number; require_verification?: boolean; require_rollback?: boolean }): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (input.region_id) {
      const region = await this.db.get('SELECT * FROM regions WHERE id = ?', [input.region_id]);
      if (!region) reasons.push('Unknown region');
      else if (region.health !== 'HEALTHY') reasons.push('Region not healthy');
      const latestHealth = await this.db.get('SELECT observed_at FROM region_health WHERE region_id = ? ORDER BY observed_at DESC LIMIT 1', [input.region_id]);
      if (!latestHealth) reasons.push('No health observation');
      else if (Date.now() - new Date(latestHealth.observed_at).getTime() > 600000) reasons.push('Stale health');
    }
    if (input.epoch !== undefined) {
      const epochRecord = await this.db.get('SELECT * FROM coordinator_epochs WHERE epoch = ?', [input.epoch]);
      if (!epochRecord || epochRecord.fenced) reasons.push('Stale or fenced epoch');
    }
    if (input.blast_radius !== undefined && input.blast_radius > 10) reasons.push('Blast radius exceeds policy');
    if (input.require_verification && !input.require_rollback) reasons.push('Rollback missing');
    return { safe: reasons.length === 0, reasons };
  }

  // ========== Approvals ==========
  async requestOptimizationApproval(input: { optimization_id: string; epoch: number; requested_by: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), 'APPROVAL_REQUESTED', 'OPTIMIZATION', input.optimization_id, input.requested_by, null, null, 'Approval requested', uuidv4(), input.epoch]);
    return id;
  }

  async approveOptimization(approval_id: string, epoch: number): Promise<void> {
    await this.db.run(`INSERT INTO optimization_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), 'APPROVAL_GRANTED', 'OPTIMIZATION_APPROVAL', approval_id, 'system', null, null, 'Approved', uuidv4(), epoch]);
  }

  async rejectOptimization(approval_id: string, epoch: number): Promise<void> {
    await this.db.run(`INSERT INTO optimization_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), 'APPROVAL_REJECTED', 'OPTIMIZATION_APPROVAL', approval_id, 'system', null, null, 'Rejected', uuidv4(), epoch]);
  }

  // ========== Execution & Verification ==========
  async executeOptimization(optimization_id: string, epoch: number): Promise<{ execution_id: string; state: string }> {
    const opt = await this.db.get('SELECT * FROM optimization_decisions WHERE id = ?', [optimization_id]);
    if (!opt) throw new Error('Optimization not found');
    if (opt.decision_state !== 'EVALUATED') throw new Error('Invalid state for execution');
    await this.db.run(`UPDATE optimization_decisions SET decision_state='EXECUTING' WHERE id = ?`, [optimization_id]);
    return { execution_id: uuidv4(), state: 'EXECUTING' };
  }

  async verifyOptimization(optimization_id: string, success: boolean): Promise<void> {
    const newState = success ? 'SUCCEEDED' : 'FAILED';
    await this.db.run(`UPDATE optimization_decisions SET decision_state=? WHERE id = ?`, [newState, optimization_id]);
  }

  // ========== Incidents ==========
  async createOptimizationIncident(input: { incident_type: string; description: string; severity?: string; region_id?: string; project_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_incidents (id, severity, description, affected_region_id, affected_project_id, incident_type, correlation_id)
      VALUES (?,?,?,?,?,?,?)`,
      [id, input.severity ?? 'MEDIUM', input.description, input.region_id ?? null, input.project_id ?? null, input.incident_type, uuidv4()]);
    return id;
  }

  async escalateOptimizationIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE optimization_incidents SET escalated=1 WHERE id = ?`, [incident_id]);
  }

  // ========== Evidence/Audit/Lineage/Learning ==========
  async generateOptimizationEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id)
      VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; region_id?: string; project_id?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, region_id, project_id, epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.region_id ?? null, input.project_id ?? null, input.epoch]);
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_lineage (id, entity_type, entity_id, phase, data, correlation_id)
      VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_learning (id, learning_type, entity_id, data, correlation_id)
      VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  // ========== Replay ==========
  async replayOptimization(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}