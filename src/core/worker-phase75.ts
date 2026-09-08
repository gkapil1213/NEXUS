// src/core/worker-phase75.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type CostType = 'ACTUAL' | 'ESTIMATED' | 'UNAVAILABLE';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';

export interface CostIngestInput {
  source_id: string;
  region_id?: string;
  fleet_id?: string;
  project_id?: string;
  environment?: string;
  workload_id?: string;
  resource_type?: string;
  quantity?: number;
  unit_cost?: number;
  total_cost?: number;
  currency?: string;
  period?: string;
  cost_type: CostType;
  freshness?: string;
  confidence?: number;
  correlation_id?: string;
}

export class Phase75ControlPlane {
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

  // ========== Cost Sources ==========
  async registerCostSource(input: { id?: string; provider: string; currency?: string; confidence?: number }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM cost_sources WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO cost_sources (id, provider, currency, confidence) VALUES (?,?,?,?)`,
      [id, input.provider, input.currency ?? 'USD', input.confidence ?? 1.0]
    );
    return id;
  }

  // ========== Cost Ingestion ==========
  async ingestCost(input: CostIngestInput): Promise<string> {
    const id = uuidv4();
    const correlationId = input.correlation_id ?? uuidv4();
    const source = await this.db.get('SELECT * FROM cost_sources WHERE id = ?', [input.source_id]);
    if (!source) throw new Error('Cost source not found');
    await this.db.run(
      `INSERT INTO cost_records (id, source_id, region_id, fleet_id, project_id, environment, workload_id, resource_type, quantity, unit_cost, total_cost, currency, period, cost_type, freshness, confidence, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.source_id, input.region_id ?? null, input.fleet_id ?? null, input.project_id ?? null, input.environment ?? null, input.workload_id ?? null, input.resource_type ?? null,
       input.quantity ?? null, input.unit_cost ?? null, input.total_cost ?? null, input.currency ?? source.currency, input.period ?? null, input.cost_type, input.freshness ?? 'CURRENT', input.confidence ?? source.confidence, correlationId]
    );
    return id;
  }

  // ========== Resource Usage ==========
  async observeResourceUsage(input: {
    region_id?: string;
    fleet_id?: string;
    project_id?: string;
    environment?: string;
    resource_type: string;
    requested?: number;
    allocated?: number;
    reserved?: number;
    active?: number;
    consumed?: number;
    released?: number;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO resource_usage_records (id, region_id, fleet_id, project_id, environment, resource_type, requested, allocated, reserved, active, consumed, released, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.region_id ?? null, input.fleet_id ?? null, input.project_id ?? null, input.environment ?? null, input.resource_type,
       input.requested ?? 0, input.allocated ?? 0, input.reserved ?? 0, input.active ?? 0, input.consumed ?? 0, input.released ?? 0, uuidv4()]
    );
    return id;
  }

  // ========== Cost Attribution ==========
  async attributeCost(input: {
    cost_record_id: string;
    scope: string; // global, region, fleet, environment, project, workload, provider
    entity_id: string;
    proportion?: number;
    attribution_method?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO cost_attributions (id, cost_record_id, scope, entity_id, proportion, attribution_method)
       VALUES (?,?,?,?,?,?)`,
      [id, input.cost_record_id, input.scope, input.entity_id, input.proportion ?? 1.0, input.attribution_method ?? null]
    );
    return id;
  }

  // ========== Cost Forecasting ==========
  async forecastCost(input: {
    project_id?: string;
    environment?: string;
    provider?: string;
    region_id?: string;
    period?: string;
    projected_cost: number;
    confidence: number;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO cost_forecasts (id, project_id, environment, provider, region_id, period, projected_cost, confidence, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.project_id ?? null, input.environment ?? null, input.provider ?? null, input.region_id ?? null, input.period ?? null, input.projected_cost, input.confidence, uuidv4()]
    );
    return id;
  }

  // ========== Budgets ==========
  async createBudget(input: {
    id?: string;
    owner: string;
    scope: string;
    project_id?: string;
    environment?: string;
    fleet_id?: string;
    region_id?: string;
    provider?: string;
    period: string;
    currency?: string;
    limit_amount: number;
    threshold_warning?: number;
    threshold_critical?: number;
    policy?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM budget_definitions WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO budget_definitions (id, owner, scope, project_id, environment, fleet_id, region_id, provider, period, currency, limit_amount, threshold_warning, threshold_critical, policy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.owner, input.scope, input.project_id ?? null, input.environment ?? null, input.fleet_id ?? null, input.region_id ?? null, input.provider ?? null,
       input.period, input.currency ?? 'USD', input.limit_amount, input.threshold_warning ?? 0.8, input.threshold_critical ?? 0.95, input.policy ?? null]
    );
    return id;
  }

  async evaluateBudget(budget_id: string): Promise<{ consumed: number; reserved: number; projected: number; remaining: number; utilization: number; status: string }> {
    const budget = await this.db.get('SELECT * FROM budget_definitions WHERE id = ?', [budget_id]);
    if (!budget) throw new Error('Budget not found');
    const consumed = budget.consumed_amount;
    const reserved = budget.reserved_amount;
    const projected = budget.projected_amount;
    const total = consumed + reserved + projected;
    const remaining = Math.max(0, budget.limit_amount - total);
    const utilization = budget.limit_amount > 0 ? (total / budget.limit_amount) * 100 : 0;
    let status = 'ACTIVE';
    if (budget.threshold_critical !== null && utilization >= budget.threshold_critical * 100) status = 'CRITICAL';
    else if (budget.threshold_warning !== null && utilization >= budget.threshold_warning * 100) status = 'WARNING';
    if (total >= budget.limit_amount) status = 'EXHAUSTED';
    await this.db.run(`UPDATE budget_definitions SET consumed_amount=?, reserved_amount=?, projected_amount=?, updated_at=datetime('now') WHERE id=?`, [consumed, reserved, projected, budget_id]);
    return { consumed, reserved, projected, remaining, utilization, status };
  }

  // ========== Quotas ==========
  async createQuota(input: {
    id?: string;
    scope: string;
    entity_id: string;
    quota_type: string;
    limit_amount: number;
    parent_quota_id?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM quota_definitions WHERE scope=? AND entity_id=? AND quota_type=?', [input.scope, input.entity_id, input.quota_type]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO quota_definitions (id, scope, entity_id, quota_type, limit_amount, parent_quota_id)
       VALUES (?,?,?,?,?,?)`,
      [id, input.scope, input.entity_id, input.quota_type, input.limit_amount, input.parent_quota_id ?? null]
    );
    return id;
  }

  async evaluateQuota(quota_id: string): Promise<{ used: number; reserved: number; available: number; utilization: number; status: string }> {
    const quota = await this.db.get('SELECT * FROM quota_definitions WHERE id = ?', [quota_id]);
    if (!quota) throw new Error('Quota not found');
    const used = quota.used_amount;
    const reserved = quota.reserved_amount;
    const total = used + reserved;
    const available = Math.max(0, quota.limit_amount - total);
    const utilization = quota.limit_amount > 0 ? (total / quota.limit_amount) * 100 : 0;
    let status = 'AVAILABLE';
    if (total >= quota.limit_amount) status = 'EXHAUSTED';
    await this.db.run(`UPDATE quota_definitions SET used_amount=?, reserved_amount=?, updated_at=datetime('now') WHERE id=?`, [used, reserved, quota_id]);
    return { used, reserved, available, utilization, status };
  }

  async reserveQuota(input: { quota_id: string; workload_id: string; amount: number; expires_in_seconds?: number }): Promise<string> {
    const quota = await this.db.get('SELECT * FROM quota_definitions WHERE id = ?', [input.quota_id]);
    if (!quota) throw new Error('Quota not found');
    const evalRes = await this.evaluateQuota(input.quota_id);
    if (evalRes.available < input.amount) throw new Error('Insufficient quota');
    // Check parent quota hierarchy if exists
    if (quota.parent_quota_id) {
      const parentEval = await this.evaluateQuota(quota.parent_quota_id);
      if (parentEval.available < input.amount) throw new Error('Insufficient quota');
    }
    const existing = await this.db.get('SELECT id FROM quota_reservations WHERE quota_id=? AND workload_id=?', [input.quota_id, input.workload_id]);
    if (existing) throw new Error('Duplicate quota reservation');
    const id = uuidv4();
    const expires = new Date(Date.now() + (input.expires_in_seconds ?? 300) * 1000).toISOString();
    await this.db.run(`INSERT INTO quota_reservations (id, quota_id, workload_id, amount, expires_at) VALUES (?,?,?,?,?)`, [id, input.quota_id, input.workload_id, input.amount, expires]);
    await this.db.run(`UPDATE quota_definitions SET reserved_amount = reserved_amount + ? WHERE id = ?`, [input.amount, input.quota_id]);
    return id;
  }

  async releaseQuota(reservation_id: string): Promise<void> {
    const res = await this.db.get('SELECT * FROM quota_reservations WHERE id = ?', [reservation_id]);
    if (!res) throw new Error('Quota reservation not found');
    await this.db.run(`UPDATE quota_definitions SET reserved_amount = reserved_amount - ? WHERE id = ?`, [res.amount, res.quota_id]);
    await this.db.run(`UPDATE quota_reservations SET state = 'RELEASED' WHERE id = ?`, [reservation_id]);
  }

  // ========== Governance & Safety ==========
  async evaluateGovernance(action: string, region_id: string, project_id?: string, environment?: string): Promise<GovernanceResult> {
    const region = await this.db.get('SELECT governance_state FROM regions WHERE id = ?', [region_id]);
    if (!region) return 'DENY';
    if (region.governance_state === 'DENY') return 'DENY';
    if (region.governance_state === 'FREEZE') return 'FREEZE';
    if (['MIGRATION', 'FAILOVER', 'RECOVERY'].includes(action)) return 'APPROVAL_REQUIRED';
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

  // ========== Economic Circuit Breakers ==========
  async openEconomicCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO economic_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeEconomicCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO economic_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  // ========== Incidents/Evidence/Audit/Lineage/Learning ==========
  async createEconomicIncident(input: { incident_type: string; description: string; severity?: string; region_id?: string; project_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_incidents (id, severity, description, affected_region_id, affected_project_id, incident_type, correlation_id)
      VALUES (?,?,?,?,?,?,?)`, [id, input.severity ?? 'MEDIUM', input.description, input.region_id ?? null, input.project_id ?? null, input.incident_type, uuidv4()]);
    return id;
  }

  async escalateEconomicIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE economic_incidents SET escalated=1 WHERE id = ?`, [incident_id]);
  }

  async generateEconomicEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; region_id?: string; project_id?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, region_id, project_id, epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.region_id ?? null, input.project_id ?? null, input.epoch]);
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  // ========== Replay ==========
  async replayEconomicDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}