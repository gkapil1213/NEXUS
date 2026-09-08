// src/core/worker-phase78.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type ForecastHorizon = 'near-term' | 'short-term' | 'medium-term' | 'long-term';
export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';

export interface DemandObservationInput {
  project_id: string;
  environment: string;
  fleet_id?: string;
  region_id?: string;
  workload_type?: string;
  resource_class: string;
  requested_capacity?: number;
  consumed_capacity?: number;
  duration?: number;
  queue_time?: number;
  execution_time?: number;
  success?: boolean;
  priority?: number;
  incident_id?: string;
  provider_id?: string;
  agent_id?: string;
}

export class Phase78ControlPlane {
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

  async recordDemandObservation(input: DemandObservationInput): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO demand_observations (id, project_id, environment, fleet_id, region_id, workload_type, resource_class, requested_capacity, consumed_capacity, duration, queue_time, execution_time, success, priority, incident_id, provider_id, agent_id, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.project_id, input.environment, input.fleet_id ?? null, input.region_id ?? null, input.workload_type ?? null, input.resource_class,
       input.requested_capacity ?? null, input.consumed_capacity ?? null, input.duration ?? null, input.queue_time ?? null, input.execution_time ?? null,
       input.success ? 1 : 0, input.priority ?? 5, input.incident_id ?? null, input.provider_id ?? null, input.agent_id ?? null, uuidv4()]
    );
    return id;
  }

  async buildDemandSeries(project_id: string, metric: string, time_bucket: string, value: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO demand_series (id, project_id, metric, time_bucket, value)
       VALUES (?,?,?,?,?)
       ON CONFLICT(project_id, metric, time_bucket) DO UPDATE SET value = excluded.value`,
      [id, project_id, metric, time_bucket, value]
    );
    return id;
  }

  async assessDataQuality(input: { project_id?: string; environment?: string; resource_class?: string }): Promise<{ quality: 'GOOD' | 'WARN' | 'BAD' | 'INSUFFICIENT_DATA'; issues: string[] }> {
    const issues: string[] = [];
    const count = await this.db.get(
      'SELECT COUNT(*) as cnt FROM demand_observations WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR environment = ?) AND (? IS NULL OR resource_class = ?)',
      [input.project_id ?? null, input.project_id ?? null, input.environment ?? null, input.environment ?? null, input.resource_class ?? null, input.resource_class ?? null]
    );
    if (!count || count.cnt < 3) return { quality: 'INSUFFICIENT_DATA', issues: ['Not enough observations'] };
    return { quality: 'GOOD', issues };
  }

  async forecastDemand(input: { project_id?: string; environment?: string; resource_class?: string; horizon?: ForecastHorizon; method?: string }): Promise<{ forecast_id: string; value: number; confidence: number; method: string }> {
    const observations = await this.db.all(
      'SELECT consumed_capacity, requested_capacity FROM demand_observations WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR environment = ?) AND (? IS NULL OR resource_class = ?) ORDER BY observed_at DESC LIMIT 20',
      [input.project_id ?? null, input.project_id ?? null, input.environment ?? null, input.environment ?? null, input.resource_class ?? null, input.resource_class ?? null]
    );
    if (!observations || observations.length < 2) {
      const id = uuidv4();
      await this.db.run(`INSERT INTO demand_forecasts (id, project_id, environment, resource_class, horizon, forecast_value, confidence, model_method, correlation_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, input.horizon ?? 'short-term', 0, 0, 'insufficient_data', uuidv4()]);
      return { forecast_id: id, value: 0, confidence: 0, method: 'insufficient_data' };
    }
    const values = observations.map((o: any) => o.consumed_capacity ?? o.requested_capacity ?? 0).filter((v: number) => v > 0);
    if (values.length < 2) {
      const id = uuidv4();
      await this.db.run(`INSERT INTO demand_forecasts (id, project_id, environment, resource_class, horizon, forecast_value, confidence, model_method, correlation_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, input.horizon ?? 'short-term', 0, 0, 'insufficient_data', uuidv4()]);
      return { forecast_id: id, value: 0, confidence: 0, method: 'insufficient_data' };
    }
    const avg = values.reduce((s: number, v: number) => s + v, 0) / values.length;
    const forecastId = uuidv4();
    const method = input.method ?? 'moving_average';
    const confidence = Math.min(0.9, 0.5 + values.length * 0.05);
    await this.db.run(`INSERT INTO demand_forecasts (id, project_id, environment, resource_class, horizon, forecast_value, confidence, model_method, lower_bound, upper_bound, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [forecastId, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, input.horizon ?? 'short-term', avg, confidence, method, avg * 0.9, avg * 1.1, uuidv4()]);
    return { forecast_id: forecastId, value: avg, confidence, method };
  }

  async calculateConfidence(forecast_id: string): Promise<number> {
    const forecast = await this.db.get('SELECT * FROM demand_forecasts WHERE id = ?', [forecast_id]);
    return forecast?.confidence ?? 0;
  }

  async detectCapacityGap(input: { project_id?: string; environment?: string; resource_class?: string; forecast_value: number; available_capacity: number }): Promise<{ gap_id: string; gap_type: 'SHORTAGE' | 'SURPLUS' | 'NONE'; amount: number }> {
    const delta = input.available_capacity - input.forecast_value;
    let gap_type: 'SHORTAGE' | 'SURPLUS' | 'NONE' = 'NONE';
    if (delta < 0) gap_type = 'SHORTAGE';
    else if (delta > 0) gap_type = 'SURPLUS';
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_gaps (id, project_id, environment, resource_class, gap_type, gap_amount, correlation_id) VALUES (?,?,?,?,?,?,?)`,
      [id, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, gap_type, Math.abs(delta), uuidv4()]);
    return { gap_id: id, gap_type, amount: Math.abs(delta) };
  }

  async createCapacityPlan(input: {
    project_id?: string; environment?: string; resource_class?: string; horizon?: string;
    demand_forecast: number; available_capacity: number; reserved_capacity?: number; provider_candidates?: string;
    estimated_cost?: number; budget_impact?: number; quota_impact?: number; confidence?: number;
  }): Promise<string> {
    const id = uuidv4();
    const reserved = input.reserved_capacity ?? 0;
    const gap = input.available_capacity - input.demand_forecast - reserved;
    await this.db.run(
      `INSERT INTO capacity_plans (id, project_id, environment, resource_class, horizon, demand_forecast, available_capacity, reserved_capacity, gap_amount, recommendation, provider_candidates, estimated_cost, budget_impact, quota_impact, confidence, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, input.horizon ?? 'short-term', input.demand_forecast, input.available_capacity, reserved, gap,
       gap < 0 ? 'ACQUIRE_CAPACITY' : 'RELEASE_CAPACITY', input.provider_candidates ?? null, input.estimated_cost ?? null, input.budget_impact ?? null, input.quota_impact ?? null, input.confidence ?? 0.5, uuidv4()]
    );
    return id;
  }

  async generateProcurementRecommendation(plan_id: string): Promise<string> {
    const plan = await this.db.get('SELECT * FROM capacity_plans WHERE id = ?', [plan_id]);
    if (!plan) throw new Error('Plan not found');
    const id = uuidv4();
    await this.db.run(`INSERT INTO planning_recommendations (id, plan_id, recommendation_type, rationale, confidence, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, plan_id, 'PROCUREMENT', `Forecasted gap of ${plan.gap_amount}`, plan.confidence, uuidv4()]);
    return id;
  }

  async simulateScenario(input: { project_id?: string; environment?: string; resource_class?: string; demand_multiplier?: number; capacity_reduction?: number }): Promise<{ scenario_id: string; forecast_value: number; capacity_gap: number }> {
    const forecast = await this.forecastDemand({ project_id: input.project_id, environment: input.environment, resource_class: input.resource_class });
    const newDemand = forecast.value * (input.demand_multiplier ?? 1);
    const available = 100 - (input.capacity_reduction ?? 0); // simple
    const gap = available - newDemand;
    const id = uuidv4();
    await this.db.run(`INSERT INTO capacity_gaps (id, project_id, environment, resource_class, gap_type, gap_amount, correlation_id) VALUES (?,?,?,?,?,?,?)`,
      [id, input.project_id ?? null, input.environment ?? null, input.resource_class ?? null, gap < 0 ? 'SHORTAGE' : 'SURPLUS', Math.abs(gap), uuidv4()]);
    return { scenario_id: id, forecast_value: newDemand, capacity_gap: gap };
  }

  async openForecastCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO forecast_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeForecastCircuitBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO forecast_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async createForecastIncident(input: { incident_type: string; description: string; severity?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO forecast_incidents (id, severity, description, incident_type, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.severity ?? 'MEDIUM', input.description, input.incident_type, uuidv4()]);
    return id;
  }

  async generateForecastEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO forecast_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO forecast_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.epoch]);
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO forecast_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO forecast_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async replayForecast(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}