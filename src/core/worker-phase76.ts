// src/core/worker-phase76.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type ProviderHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'MAINTENANCE' | 'FROZEN';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';

export interface ProviderInput {
  id?: string;
  provider_name: string;
  provider_type: string;
  ownership: string;
  trust_level?: string;
}

export interface ProcurementRequirementInput {
  id?: string;
  project_id: string;
  environment: string;
  fleet_id?: string;
  region_id?: string;
  workload_class?: string;
  required_capability?: string;
  resource_type: string;
  quantity: number;
  priority?: number;
  reason?: string;
  urgency?: string;
  idempotency_key: string;
}

export class Phase76ControlPlane {
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

  async registerProvider(input: ProviderInput): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM resource_providers WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO resource_providers (id, provider_name, provider_type, ownership, trust_level)
       VALUES (?,?,?,?,?)`,
      [id, input.provider_name, input.provider_type, input.ownership, input.trust_level ?? 'STANDARD']
    );
    return id;
  }

  async registerProviderCapability(provider_id: string, capability: string): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_capabilities (id, provider_id, capability) VALUES (?,?,?)
       ON CONFLICT(provider_id, capability) DO NOTHING`,
      [uuidv4(), provider_id, capability]
    );
  }

  async registerProviderRegion(provider_id: string, region_id: string, quota_limit?: number): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_regions (id, provider_id, region_id, provider_quota_limit)
       VALUES (?,?,?,?)
       ON CONFLICT(provider_id, region_id) DO UPDATE SET provider_quota_limit = excluded.provider_quota_limit`,
      [uuidv4(), provider_id, region_id, quota_limit ?? null]
    );
  }

  async observeProviderHealth(provider_id: string, region_id: string | null, health_state: ProviderHealth): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_health (id, provider_id, region_id, health_state, correlation_id)
       VALUES (?,?,?,?,?)`,
      [uuidv4(), provider_id, region_id, health_state, uuidv4()]
    );
    await this.db.run(`UPDATE resource_providers SET health = ?, updated_at = datetime('now') WHERE id = ?`, [health_state, provider_id]);
    if (region_id !== null) {
      await this.db.run(`UPDATE provider_regions SET health = ? WHERE provider_id = ? AND region_id = ?`, [health_state, provider_id, region_id]);
    }
  }

  async observeProviderCapacity(provider_id: string, region_id: string, resource_type: string, total_capacity: number, available_capacity: number, reserved_capacity: number = 0): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_resources (id, provider_id, region_id, resource_type, total_capacity, available_capacity, reserved_capacity, correlation_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), provider_id, region_id, resource_type, total_capacity, available_capacity, reserved_capacity, uuidv4()]
    );
  }

  async evaluateProviderEligibility(provider_id: string, region_id?: string): Promise<{ eligible: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const provider = await this.db.get('SELECT * FROM resource_providers WHERE id = ?', [provider_id]);
    if (!provider) reasons.push('Unknown provider');
    else {
      if (provider.health === 'UNKNOWN') reasons.push('Unknown provider health');
      if (provider.health === 'UNHEALTHY' || provider.health === 'FROZEN') reasons.push('Provider unhealthy');
    }
    if (region_id) {
      const region = await this.db.get('SELECT * FROM provider_regions WHERE provider_id = ? AND region_id = ?', [provider_id, region_id]);
      if (!region) reasons.push('Provider region not found');
      else if (region.health === 'UNKNOWN') reasons.push('Unknown region health');
    }
    return { eligible: reasons.length === 0, reasons };
  }

  async detectCapacityDemand(project_id: string, environment: string, resource_type: string, required_qty: number, available_qty: number): Promise<boolean> {
    return available_qty < required_qty;
  }

  async createProcurementRequirement(input: ProcurementRequirementInput): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM procurement_requirements WHERE idempotency_key = ?', [input.idempotency_key]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO procurement_requirements (id, project_id, environment, fleet_id, region_id, workload_class, required_capability, resource_type, quantity, priority, reason, urgency, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.project_id, input.environment, input.fleet_id ?? null, input.region_id ?? null, input.workload_class ?? null, input.required_capability ?? null, input.resource_type, input.quantity, input.priority ?? 5, input.reason ?? null, input.urgency ?? 'NORMAL', input.idempotency_key]
    );
    return id;
  }

  async createProcurementPlan(requirement_id: string): Promise<string> {
    const planId = uuidv4();
    await this.db.run(`INSERT INTO procurement_plans (id, requirement_id, state) VALUES (?,?,?)`, [planId, requirement_id, 'DRAFT']);
    return planId;
  }

  async generateProviderCandidates(plan_id: string): Promise<string[]> {
    const plan = await this.db.get('SELECT * FROM procurement_plans WHERE id = ?', [plan_id]);
    if (!plan) throw new Error('Plan not found');
    const req = await this.db.get('SELECT * FROM procurement_requirements WHERE id = ?', [plan.requirement_id]);
    if (!req) throw new Error('Requirement not found');
    const providers = await this.db.all('SELECT * FROM resource_providers');
    const candidateIds: string[] = [];
    for (const provider of providers) {
      const elig = await this.evaluateProviderEligibility(provider.id, req.region_id ?? undefined);
      const candidateId = uuidv4();
      await this.db.run(
        `INSERT INTO procurement_candidates (id, plan_id, provider_id, region_id, eligible, reason)
         VALUES (?,?,?,?,?,?)`,
        [candidateId, plan_id, provider.id, req.region_id ?? '', elig.eligible ? 1 : 0, elig.reasons.join(', ')]
      );
      if (elig.eligible) candidateIds.push(candidateId);
    }
    return candidateIds;
  }

  async scoreProviderCandidates(plan_id: string): Promise<void> {
    const candidates = await this.db.all('SELECT * FROM procurement_candidates WHERE plan_id = ?', [plan_id]);
    for (const c of candidates) {
      let score = 0;
      const provider = await this.db.get('SELECT health, trust_level FROM resource_providers WHERE id = ?', [c.provider_id]);
      if (provider) {
        if (provider.health === 'HEALTHY') score += 50;
        else if (provider.health === 'DEGRADED') score += 30;
        if (provider.trust_level === 'HIGH') score += 20;
      }
      await this.db.run(`UPDATE procurement_candidates SET score = ? WHERE id = ?`, [score, c.id]);
    }
  }

  async selectProvider(plan_id: string): Promise<{ provider_id: string; region_id: string; candidate_id: string }> {
    await this.scoreProviderCandidates(plan_id);
    const candidates = await this.db.all('SELECT * FROM procurement_candidates WHERE plan_id = ? AND eligible = 1 ORDER BY score DESC, provider_id ASC', [plan_id]);
    if (candidates.length === 0) throw new Error('No eligible providers');
    const selected = candidates[0];
    await this.db.run(`UPDATE procurement_plans SET provider_id = ?, region_id = ?, state = 'PROVIDER_SELECTED' WHERE id = ?`, [selected.provider_id, selected.region_id, plan_id]);
    return { provider_id: selected.provider_id, region_id: selected.region_id, candidate_id: selected.id };
  }

  async evaluateProcurementBudget(project_id: string, estimated_cost: number): Promise<{ allowed: boolean; budget_id?: string; status?: string }> {
    const budget = await this.db.get('SELECT * FROM budget_definitions WHERE project_id = ? AND scope = ?', [project_id, 'project']);
    if (!budget) return { allowed: true };
    const remaining = budget.limit_amount - budget.consumed_amount - budget.reserved_amount - budget.projected_amount;
    if (estimated_cost > remaining) return { allowed: false, budget_id: budget.id, status: 'INSUFFICIENT' };
    return { allowed: true, budget_id: budget.id, status: 'OK' };
  }

  async evaluateProcurementQuota(project_id: string, resource_type: string, quantity: number): Promise<{ allowed: boolean; quota_id?: string }> {
    const quota = await this.db.get('SELECT * FROM quota_definitions WHERE scope = ? AND entity_id = ? AND quota_type = ?', ['project', project_id, resource_type]);
    if (!quota) return { allowed: true };
    const available = quota.limit_amount - quota.used_amount - quota.reserved_amount;
    if (quantity > available) return { allowed: false, quota_id: quota.id };
    return { allowed: true, quota_id: quota.id };
  }

  async reserveProcurementResources(decision_id: string, scope: string, entity_id: string, amount: number, expires_in_seconds?: number): Promise<string> {
    const existing = await this.db.get('SELECT id FROM procurement_reservations WHERE decision_id = ? AND scope = ? AND entity_id = ?', [decision_id, scope, entity_id]);
    if (existing) throw new Error('Duplicate reservation');
    const id = uuidv4();
    const expires = new Date(Date.now() + (expires_in_seconds ?? 300) * 1000).toISOString();
    await this.db.run(`INSERT INTO procurement_reservations (id, decision_id, scope, entity_id, amount, expires_at) VALUES (?,?,?,?,?,?)`, [id, decision_id, scope, entity_id, amount, expires]);
    return id;
  }

  async acquireCapacity(decision_id: string, provider_id: string, region_id: string, resource_type: string, quantity: number): Promise<string> {
    const elig = await this.evaluateProviderEligibility(provider_id, region_id);
    if (!elig.eligible) throw new Error('Provider ineligible');
    const cap = await this.db.get('SELECT available_capacity FROM provider_resources WHERE provider_id = ? AND region_id = ? AND resource_type = ? ORDER BY observed_at DESC LIMIT 1', [provider_id, region_id, resource_type]);
    if (!cap || cap.available_capacity < quantity) throw new Error('Insufficient provider capacity');
    const acqId = uuidv4();
    await this.db.run(`INSERT INTO acquisition_operations (id, decision_id, provider_id, region_id, resource_type, quantity, state, correlation_id) VALUES (?,?,?,?,?,?,?,?)`, [acqId, decision_id, provider_id, region_id, resource_type, quantity, 'ACQUIRING', uuidv4()]);
    return acqId;
  }

  async provisionCapacity(acquisition_id: string): Promise<string> {
    const acq = await this.db.get('SELECT * FROM acquisition_operations WHERE id = ?', [acquisition_id]);
    if (!acq) throw new Error('Acquisition not found');
    const provId = uuidv4();
    await this.db.run(`INSERT INTO provisioning_operations (id, acquisition_id, state) VALUES (?,?,?)`, [provId, acquisition_id, 'PROVISIONING']);
    await this.db.run(`UPDATE acquisition_operations SET state = 'PROVISIONING' WHERE id = ?`, [acquisition_id]);
    return provId;
  }

  async registerCapacity(provisioning_id: string, provider_id: string, region_id: string, resource_type: string, quantity: number): Promise<string> {
    const resId = uuidv4();
    await this.db.run(`INSERT INTO provisioned_resources (id, provider_id, region_id, resource_type, quantity, state, verified) VALUES (?,?,?,?,?,?,?)`, [resId, provider_id, region_id, resource_type, quantity, 'PENDING_VERIFICATION', 0]);
    const regId = uuidv4();
    await this.db.run(`INSERT INTO capacity_registrations (id, provisioned_resource_id, fleet_id, region_id, resource_type, quantity, state) VALUES (?,?,?,?,?,?,?)`, [regId, resId, null, region_id, resource_type, quantity, 'PENDING']);
    await this.db.run(`UPDATE provisioning_operations SET provider_resource_id = ?, state = 'REGISTERING' WHERE id = ?`, [resId, provisioning_id]);
    return regId;
  }

  async verifyCapacity(registration_id: string, verified: boolean): Promise<void> {
    const reg = await this.db.get('SELECT * FROM capacity_registrations WHERE id = ?', [registration_id]);
    if (!reg) throw new Error('Registration not found');
    await this.db.run(
      `UPDATE provisioned_resources SET verified = ?, state = CASE WHEN ? THEN 'ACTIVE' ELSE 'FAILED' END WHERE id = ?`,
      [verified ? 1 : 0, verified ? 1 : 0, reg.provisioned_resource_id]
    );
    await this.db.run(`UPDATE capacity_registrations SET state = ? WHERE id = ?`, [verified ? 'ACTIVE' : 'FAILED', registration_id]);
  }

  async scaleUp(provider_id: string, region_id: string, resource_type: string, quantity: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_scaling_operations (id, provider_id, region_id, resource_type, direction, quantity, state, correlation_id) VALUES (?,?,?,?,?,?,?,?)`, [id, provider_id, region_id, resource_type, 'UP', quantity, 'REQUESTED', uuidv4()]);
    return id;
  }

  async scaleDown(provider_id: string, region_id: string, resource_type: string, quantity: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_scaling_operations (id, provider_id, region_id, resource_type, direction, quantity, state, correlation_id) VALUES (?,?,?,?,?,?,?,?)`, [id, provider_id, region_id, resource_type, 'DOWN', quantity, 'REQUESTED', uuidv4()]);
    return id;
  }

  async acquireBurstCapacity(provider_id: string, region_id: string, resource_type: string, quantity: number, expiry_time: string, owner: string, max_cost?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO burst_capacity (id, provider_id, region_id, resource_type, quantity, expiry_time, owner, max_cost) VALUES (?,?,?,?,?,?,?,?)`, [id, provider_id, region_id, resource_type, quantity, expiry_time, owner, max_cost ?? null]);
    return id;
  }

  async acquireReservedCapacity(provider_id: string, region_id: string, resource_type: string, quantity: number, end_time?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO reserved_capacity (id, provider_id, region_id, resource_type, quantity, end_time) VALUES (?,?,?,?,?,?)`, [id, provider_id, region_id, resource_type, quantity, end_time ?? null]);
    return id;
  }

  async acquireEmergencyCapacity(provider_id: string, region_id: string, resource_type: string, quantity: number, incident_id?: string, authorized_by?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO emergency_capacity (id, provider_id, region_id, resource_type, quantity, incident_id, authorized_by) VALUES (?,?,?,?,?,?,?)`, [id, provider_id, region_id, resource_type, quantity, incident_id ?? null, authorized_by ?? null]);
    return id;
  }

  async failoverProvider(provider_id: string, reason: string): Promise<void> {
    await this.db.run(`UPDATE resource_providers SET health = 'UNHEALTHY' WHERE id = ?`, [provider_id]);
    await this.openProviderCircuitBreaker('provider', provider_id);
  }

  async openProviderCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_circuit_breakers (id, scope, entity_id, state, opened_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'OPEN']
    );
  }

  async closeProviderCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(
      `INSERT INTO provider_circuit_breakers (id, scope, entity_id, state, closed_at)
       VALUES (?,?,?,?,datetime('now'))
       ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'CLOSED']
    );
  }

  async freezeProcurement(scope: string, entity_id: string): Promise<void> {
    await this.openProviderCircuitBreaker('procurement_' + scope, entity_id);
  }

  async releaseCapacity(provisioned_resource_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_release_operations (id, provisioned_resource_id, reason, state) VALUES (?,?,?,?)`, [id, provisioned_resource_id, reason ?? null, 'REQUESTED']);
    await this.db.run(`UPDATE provisioned_resources SET state = 'RELEASE_PENDING' WHERE id = ?`, [provisioned_resource_id]);
    return id;
  }

  async createProcurementIncident(input: { incident_type: string; description: string; severity?: string; provider_id?: string; project_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procurement_incidents (id, severity, description, affected_provider_id, affected_project_id, incident_type, correlation_id) VALUES (?,?,?,?,?,?,?)`, [id, input.severity ?? 'MEDIUM', input.description, input.provider_id ?? null, input.project_id ?? null, input.incident_type, uuidv4()]);
    return id;
  }

  async escalateProcurementIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE procurement_incidents SET escalated=1 WHERE id=?`, [incident_id]);
  }

  async generateProcurementEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procurement_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; provider_id?: string; project_id?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procurement_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, provider_id, project_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.provider_id ?? null, input.project_id ?? null, input.epoch]);
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procurement_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procurement_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async replayProcurementDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}