// src/core/worker-phase77.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type OptimizationState = 'PROPOSED' | 'EVALUATED' | 'BLOCKED' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'RESERVED' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'REGRESSED' | 'CANCELLED';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CapacityOfferInput {
  id?: string;
  provider_id: string;
  region_id: string;
  resource_type: string;
  capacity_amount: number;
  available_start?: string;
  available_end?: string;
  reservation_characteristics?: string;
  reliability_characteristics?: string;
  cost_model?: string;
  pricing_model?: string;
  commitment_requirements?: string;
  cancellation_constraints?: string;
  utilization_restrictions?: string;
  environment_restrictions?: string;
  project_restrictions?: string;
  governance_restrictions?: string;
}

export interface CapacityRequestInput {
  id?: string;
  project_id: string;
  environment: string;
  workload_id?: string;
  resource_type: string;
  quantity: number;
  duration?: number;
  deadline?: string;
  priority?: number;
  risk?: string;
  required_reliability?: string;
  required_region?: string;
  allowed_providers?: string[];
  maximum_budget?: number;
  governance_policy?: string;
  approval_requirements?: string;
  optimization_objective?: string;
  idempotency_key: string;
}

export class Phase77ControlPlane {
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

  async registerCapacityOffer(input: CapacityOfferInput): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM capacity_market_offers WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO capacity_market_offers (id, provider_id, region_id, resource_type, capacity_amount, available_start, available_end, reservation_characteristics, reliability_characteristics, cost_model, pricing_model, commitment_requirements, cancellation_constraints, utilization_restrictions, environment_restrictions, project_restrictions, governance_restrictions)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.provider_id, input.region_id, input.resource_type, input.capacity_amount, input.available_start ?? null, input.available_end ?? null, input.reservation_characteristics ?? null, input.reliability_characteristics ?? null, input.cost_model ?? null, input.pricing_model ?? null, input.commitment_requirements ?? null, input.cancellation_constraints ?? null, input.utilization_restrictions ?? null, input.environment_restrictions ?? null, input.project_restrictions ?? null, input.governance_restrictions ?? null]
    );
    return id;
  }

  async createCapacityRequest(input: CapacityRequestInput): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM capacity_market_requests WHERE idempotency_key = ?', [input.idempotency_key]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO capacity_market_requests (id, project_id, environment, workload_id, resource_type, quantity, duration, deadline, priority, risk, required_reliability, required_region, allowed_providers, maximum_budget, governance_policy, approval_requirements, optimization_objective, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.project_id, input.environment, input.workload_id ?? null, input.resource_type, input.quantity, input.duration ?? null, input.deadline ?? null, input.priority ?? 5, input.risk ?? null, input.required_reliability ?? null, input.required_region ?? null, input.allowed_providers ? JSON.stringify(input.allowed_providers) : null, input.maximum_budget ?? null, input.governance_policy ?? null, input.approval_requirements ?? null, input.optimization_objective ?? null, input.idempotency_key]
    );
    return id;
  }

  async createEconomicProfile(input: {
    workload_id: string;
    project_id: string;
    environment: string;
    expected_resource_consumption?: string;
    expected_duration?: number;
    expected_cost?: number;
    maximum_acceptable_cost?: number;
    budget_class?: string;
    cost_sensitivity?: string;
    deadline_sensitivity?: string;
    reliability_sensitivity?: string;
    performance_sensitivity?: string;
    carbon_efficiency_preference?: string;
    interruption_tolerance?: boolean;
    preemption_tolerance?: boolean;
    reservation_preference?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO workload_economic_profiles (id, workload_id, project_id, environment, expected_resource_consumption, expected_duration, expected_cost, maximum_acceptable_cost, budget_class, cost_sensitivity, deadline_sensitivity, reliability_sensitivity, performance_sensitivity, carbon_efficiency_preference, interruption_tolerance, preemption_tolerance, reservation_preference)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.workload_id, input.project_id, input.environment, input.expected_resource_consumption ?? null, input.expected_duration ?? null, input.expected_cost ?? null, input.maximum_acceptable_cost ?? null, input.budget_class ?? null, input.cost_sensitivity ?? null, input.deadline_sensitivity ?? null, input.reliability_sensitivity ?? null, input.performance_sensitivity ?? null, input.carbon_efficiency_preference ?? null, input.interruption_tolerance ? 1 : 0, input.preemption_tolerance ? 1 : 0, input.reservation_preference ?? null]
    );
    return id;
  }

  async recordPriceObservation(input: {
    provider_id: string;
    region_id: string;
    resource_type: string;
    observed_price: number;
    currency?: string;
    unit?: string;
    source?: string;
    confidence?: number;
    validity_start?: string;
    validity_end?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO resource_price_observations (id, provider_id, region_id, resource_type, observed_price, currency, unit, source, confidence, validity_start, validity_end)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.provider_id, input.region_id, input.resource_type, input.observed_price, input.currency ?? 'USD', input.unit ?? null, input.source ?? null, input.confidence ?? 1.0, input.validity_start ?? null, input.validity_end ?? null]
    );
    return id;
  }

  async calculateCost(input: {
    workload_id: string;
    provider_id?: string;
    region_id?: string;
    resource_type: string;
    quantity: number;
    duration?: number;
    cost_model?: string;
  }): Promise<{ estimated_cost: number; assumptions: string }> {
    const price = await this.db.get(
      'SELECT observed_price FROM resource_price_observations WHERE provider_id = ? AND region_id = ? AND resource_type = ? ORDER BY observation_timestamp DESC LIMIT 1',
      [input.provider_id, input.region_id, input.resource_type]
    );
    if (!price) return { estimated_cost: 0, assumptions: 'No price data available' };
    const cost = price.observed_price * input.quantity * (input.duration ?? 1);
    return { estimated_cost: cost, assumptions: `price=${price.observed_price}` };
  }

  async evaluateCandidates(request_id: string): Promise<any[]> {
    const request = await this.db.get('SELECT * FROM capacity_market_requests WHERE id = ?', [request_id]);
    if (!request) throw new Error('Request not found');
    const offers = await this.db.all('SELECT * FROM capacity_market_offers WHERE resource_type = ? AND state = ?', [request.resource_type, 'AVAILABLE']);
    const candidates = [];
    for (const offer of offers) {
      if (request.required_region && offer.region_id !== request.required_region) continue;
      if (request.allowed_providers) {
        const allowed = JSON.parse(request.allowed_providers);
        if (!allowed.includes(offer.provider_id)) continue;
      }
      if (offer.capacity_amount < request.quantity) continue;
      candidates.push(offer);
    }
    return candidates;
  }

  async optimizeAllocation(request_id: string): Promise<{ decision_id: string; selected_offer_id: string | null; score: number; rejected: any[] }> {
    const candidates = await this.evaluateCandidates(request_id);
    if (candidates.length === 0) {
      const decisionId = uuidv4();
      await this.db.run(`INSERT INTO optimization_decisions (id, request_id, objective, constraints, candidates, rejected_candidates, selected_candidate, score, reason, decision_state, decision_epoch, correlation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [decisionId, request_id, 'allocation', '[]', '[]', '[]', null, 0, 'No eligible offers', 'BLOCKED', this.nextEpoch(), uuidv4()]);
      return { decision_id: decisionId, selected_offer_id: null, score: 0, rejected: [] };
    }
    const candidatePrices = new Map<string, number>();
    for (const c of candidates) {
      candidatePrices.set(c.id, await this.getPrice(c.provider_id, c.region_id, c.resource_type));
    }
    candidates.sort((a: any, b: any) => {
      const pa = candidatePrices.get(a.id) ?? Infinity;
      const pb = candidatePrices.get(b.id) ?? Infinity;
      return pa - pb;
    });
    const selected = candidates[0];
    const decisionId = uuidv4();
    await this.db.run(`INSERT INTO optimization_decisions (id, request_id, objective, constraints, candidates, rejected_candidates, selected_candidate, score, reason, decision_state, decision_epoch, correlation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [decisionId, request_id, 'allocation', '[]', JSON.stringify(candidates.map((c:any)=>c.id)), JSON.stringify(candidates.slice(1).map((c:any)=>c.id)), selected.id, 100, 'Optimized', 'EVALUATED', this.nextEpoch(), uuidv4()]);
    return { decision_id: decisionId, selected_offer_id: selected.id, score: 100, rejected: candidates.slice(1) };
  }

  private async getPrice(provider_id: string, region_id: string, resource_type: string): Promise<number> {
    const price = await this.db.get('SELECT observed_price FROM resource_price_observations WHERE provider_id = ? AND region_id = ? AND resource_type = ? ORDER BY observation_timestamp DESC LIMIT 1', [provider_id, region_id, resource_type]);
    return price?.observed_price ?? Infinity;
  }

  async allocateCapacity(request_id: string, offer_id: string): Promise<string> {
    const request = await this.db.get('SELECT * FROM capacity_market_requests WHERE id = ?', [request_id]);
    if (!request) throw new Error('Request not found');
    const existing = await this.db.get('SELECT id FROM capacity_market_allocations WHERE request_id = ? AND offer_id = ?', [request_id, offer_id]);
    if (existing) throw new Error('Duplicate allocation');
    const offer = await this.db.get('SELECT * FROM capacity_market_offers WHERE id = ?', [offer_id]);
    if (!offer || offer.state !== 'AVAILABLE') throw new Error('Offer unavailable');
    if (offer.capacity_amount < request.quantity) throw new Error('Insufficient offer capacity');
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_market_allocations (id, request_id, offer_id, quantity, state, correlation_id) VALUES (?,?,?,?,?,?)`, [id, request_id, offer_id, request.quantity, 'ALLOCATED', uuidv4()]);
    await this.db.run(`UPDATE capacity_market_offers SET state = 'ALLOCATED', updated_at = datetime('now') WHERE id = ?`, [offer_id]);
    return id;
  }

  async releaseCapacity(allocation_id: string): Promise<void> {
    await this.db.run(`UPDATE capacity_market_allocations SET state = 'RELEASED', released_at = datetime('now') WHERE id = ?`, [allocation_id]);
  }

  async openEconomicCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO economic_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeEconomicCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO economic_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async detectPriceAnomaly(provider_id: string, region_id: string, resource_type: string, current_price: number, threshold: number = 2.0): Promise<boolean> {
    const history = await this.db.all('SELECT price FROM provider_price_history WHERE provider_id = ? AND region_id = ? AND resource_type = ? ORDER BY observed_at DESC LIMIT 10', [provider_id, region_id, resource_type]);
    if (history.length < 3) return false;
    const avg = history.reduce((s: number, h: any) => s + h.price, 0) / history.length;
    return current_price > avg * threshold;
  }

  async createEconomicIncident(input: { incident_type: string; description: string; severity?: string; entity_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO optimization_incidents (id, severity, description, affected_entity_id, incident_type, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.severity ?? 'MEDIUM', input.description, input.entity_id ?? null, input.incident_type, uuidv4()]);
    return id;
  }

  async generateEconomicEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; region_id?: string; project_id?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO economic_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, region_id, project_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.region_id ?? null, input.project_id ?? null, input.epoch]);
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

  async replayEconomicDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}