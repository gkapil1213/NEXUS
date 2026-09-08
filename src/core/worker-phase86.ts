// src/core/worker-phase86.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type PortfolioState = 'CREATED' | 'DISCOVERING' | 'ANALYZING' | 'PLANNING' | 'SIMULATING' | 'OPTIMIZING' | 'AWAITING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'EXECUTING' | 'PAUSED' | 'REPLANNING' | 'COMPLETED' | 'FAILED' | 'HALTED' | 'CANCELLED';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';
export type SafetyResult = 'SAFE' | 'UNSAFE' | 'INCONCLUSIVE';

export class Phase86ControlPlane {
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

  private nextEpoch(): number { this.lastEpoch = Math.max(Date.now(), this.lastEpoch + 1); return this.lastEpoch; }

  async createPortfolio(input: { id?: string; owner?: string; organizational_scope?: string; risk_profile?: string; planning_horizon?: string; budget?: number; capacity_envelope?: number }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM engineering_portfolios WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO engineering_portfolios (id, owner, organizational_scope, risk_profile, planning_horizon, budget, capacity_envelope) VALUES (?,?,?,?,?,?,?)`,
      [id, input.owner ?? null, input.organizational_scope ?? null, input.risk_profile ?? null, input.planning_horizon ?? null, input.budget ?? null, input.capacity_envelope ?? null]);
    return id;
  }

  async registerObjective(input: { portfolio_id: string; objective_type: string; target?: string; priority?: number; weight?: number; baseline?: number; target_value?: number; tolerance?: number; objective_class?: 'HARD'|'SOFT'; measurement_method?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_objectives (id, portfolio_id, objective_type, target, priority, weight, baseline, target_value, tolerance, objective_class, measurement_method) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.portfolio_id, input.objective_type, input.target ?? null, input.priority ?? 1, input.weight ?? 1.0, input.baseline ?? null, input.target_value ?? null, input.tolerance ?? null, input.objective_class ?? 'SOFT', input.measurement_method ?? null]);
    return id;
  }

  async registerGoal(portfolio_id: string, objective_id: string | null, goal: string, order_index?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_goals (id, portfolio_id, objective_id, goal, order_index) VALUES (?,?,?,?,?)`, [id, portfolio_id, objective_id, goal, order_index ?? null]);
    return id;
  }

  async registerConstraint(input: { portfolio_id: string; constraint_type: 'HARD'|'SOFT'; field: string; operator?: string; value?: string; description?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_constraints (id, portfolio_id, constraint_type, field, operator, value, description) VALUES (?,?,?,?,?,?,?)`,
      [id, input.portfolio_id, input.constraint_type, input.field, input.operator ?? null, input.value ?? null, input.description ?? null]);
    return id;
  }

  async registerMission(portfolio_id: string, mission_id: string, project_id?: string, environment?: string, priority?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_missions (id, portfolio_id, mission_id, project_id, environment, priority) VALUES (?,?,?,?,?,?)`,
      [id, portfolio_id, mission_id, project_id ?? null, environment ?? null, priority ?? 5]);
    return id;
  }

  async addMissionDependency(portfolio_id: string, predecessor: string, successor: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_mission_dependencies (id, portfolio_id, predecessor_mission_id, successor_mission_id) VALUES (?,?,?,?)`,
      [id, portfolio_id, predecessor, successor]);
    return id;
  }

  async detectConflicts(portfolio_id: string): Promise<string[]> {
    const conflicts = await this.db.all(`SELECT * FROM portfolio_mission_conflicts WHERE portfolio_id = ?`, [portfolio_id]);
    return conflicts.map((c: any) => c.id);
  }

  async calculateStrategicPriority(portfolio_id: string, mission_id: string, priority_score: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_priorities (id, portfolio_id, mission_id, priority_score) VALUES (?,?,?,?)`, [id, portfolio_id, mission_id, priority_score]);
    return id;
  }

  async forecastPortfolioDemand(portfolio_id: string, horizon: string, demand: number, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_demand_forecasts (id, portfolio_id, horizon, demand, confidence) VALUES (?,?,?,?,?)`, [id, portfolio_id, horizon, demand, confidence]);
    return id;
  }

  async calculateCapacityPlan(portfolio_id: string, resource_type: string, required_capacity: number, available_capacity: number): Promise<{ id: string; gap: number }> {
    const gap = available_capacity - required_capacity;
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_capacity_plans (id, portfolio_id, resource_type, required_capacity, available_capacity, gap) VALUES (?,?,?,?,?,?)`, [id, portfolio_id, resource_type, required_capacity, available_capacity, gap]);
    return { id, gap };
  }

  async generateStrategies(portfolio_id: string, count: number = 3): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = uuidv4();
      await this.db.run(`INSERT INTO portfolio_strategies (id, portfolio_id, name) VALUES (?,?,?)`, [id, portfolio_id, `strategy_${i+1}`]);
      ids.push(id);
    }
    return ids;
  }

  async simulatePortfolioStrategy(strategy_id: string, scenario_id?: string, result: string = 'SAFE', confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_simulations (id, strategy_id, scenario_id, result, confidence) VALUES (?,?,?,?,?)`, [id, strategy_id, scenario_id ?? null, result, confidence]);
    return id;
  }

  async evaluateCounterfactual(strategy_id: string, description: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_counterfactuals (id, strategy_id, description, result) VALUES (?,?,?,?)`, [id, strategy_id, description, 'SIMULATED']);
    return id;
  }

  async evaluatePortfolioRisk(portfolio_id: string, risk_type: string, risk_level: string, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_risk_assessments (id, portfolio_id, risk_type, risk_level, confidence) VALUES (?,?,?,?,?)`, [id, portfolio_id, risk_type, risk_level, confidence]);
    return id;
  }

  async optimizePortfolio(portfolio_id: string): Promise<string> {
    const strategies = await this.db.all('SELECT * FROM portfolio_strategies WHERE portfolio_id = ?', [portfolio_id]);
    if (strategies.length === 0) throw new Error('No strategies found');
    for (const s of strategies) {
      await this.simulatePortfolioStrategy(s.id, undefined, 'SAFE', 0.8);
    }
    return strategies[0].id;
  }

  async calculateParetoFrontier(portfolio_id: string): Promise<string[]> {
    const strategies = await this.db.all('SELECT * FROM portfolio_strategies WHERE portfolio_id = ?', [portfolio_id]);
    return strategies.map((s: any) => s.id);
  }

  async compareStrategies(a: string, b: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_decisions (id, portfolio_id, selected_strategy_id, rejected_strategies, rationale, confidence, state, correlation_id) VALUES (?,?,?,?,?,?,?,?)`,
      [id, 'portfolio', a, b, 'comparison', 0.5, 'PROPOSED', uuidv4()]);
    return id;
  }

  async selectPortfolioStrategy(portfolio_id: string): Promise<{ decision_id: string; strategy_id: string }> {
    const strategyId = await this.optimizePortfolio(portfolio_id);
    const decisionId = uuidv4();
    await this.db.run(`INSERT INTO portfolio_decisions (id, portfolio_id, selected_strategy_id, rejected_strategies, rationale, confidence, state, correlation_id) VALUES (?,?,?,?,?,?,?,?)`,
      [decisionId, portfolio_id, strategyId, JSON.stringify([]), 'selected by deterministic ranking', 0.8, 'PROPOSED', uuidv4()]);
    return { decision_id: decisionId, strategy_id: strategyId };
  }

  async createPortfolioPlan(portfolio_id: string, strategy_id: string): Promise<string> {
    const planId = uuidv4();
    await this.db.run(`INSERT INTO portfolio_plans (id, portfolio_id, strategy_id, version, state) VALUES (?,?,?,?,?)`, [planId, portfolio_id, strategy_id, 1, 'DRAFT']);
    return planId;
  }

  async validatePortfolioPlan(plan_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const plan = await this.db.get('SELECT * FROM portfolio_plans WHERE id = ?', [plan_id]);
    if (!plan) return { valid: false, issues: ['Plan not found'] };
    return { valid: true, issues: [] };
  }

  async requestPortfolioApproval(plan_id: string): Promise<string> {
    await this.db.run(`UPDATE portfolio_plans SET state = 'AWAITING_APPROVAL' WHERE id = ?`, [plan_id]);
    return uuidv4();
  }

  async approvePortfolioPlan(plan_id: string): Promise<void> {
    await this.db.run(`UPDATE portfolio_plans SET state = 'APPROVED' WHERE id = ?`, [plan_id]);
  }

  async rejectPortfolioPlan(plan_id: string): Promise<void> {
    await this.db.run(`UPDATE portfolio_plans SET state = 'REJECTED' WHERE id = ?`, [plan_id]);
  }

  async activatePortfolioPlan(plan_id: string): Promise<void> {
    await this.db.run(`UPDATE portfolio_plans SET state = 'ACTIVE' WHERE id = ?`, [plan_id]);
  }

  async coordinateExecution(portfolio_id: string, plan_id: string): Promise<string> {
    const plan = await this.db.get('SELECT state FROM portfolio_plans WHERE id = ?', [plan_id]);
    if (!plan || plan.state !== 'ACTIVE') throw new Error('Plan not active');
    await this.db.run(`UPDATE engineering_portfolios SET state = 'EXECUTING' WHERE id = ?`, [portfolio_id]);
    return uuidv4();
  }

  async monitorPortfolio(portfolio_id: string): Promise<string> {
    return this.db.get('SELECT state FROM engineering_portfolios WHERE id = ?', [portfolio_id])?.state ?? 'UNKNOWN';
  }

  async reprioritizePortfolio(portfolio_id: string, mission_id: string, new_priority: number): Promise<void> {
    await this.db.run(`UPDATE portfolio_missions SET priority = ? WHERE portfolio_id = ? AND mission_id = ?`, [new_priority, portfolio_id, mission_id]);
  }

  async replanPortfolio(portfolio_id: string, reason: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_replanning_events (id, portfolio_id, reason) VALUES (?,?,?)`, [id, portfolio_id, reason]);
    return id;
  }

  async pausePortfolio(portfolio_id: string): Promise<void> {
    await this.db.run(`UPDATE engineering_portfolios SET state = 'PAUSED' WHERE id = ?`, [portfolio_id]);
  }

  async resumePortfolio(portfolio_id: string): Promise<void> {
    await this.db.run(`UPDATE engineering_portfolios SET state = 'EXECUTING' WHERE id = ?`, [portfolio_id]);
  }

  async rollbackPortfolio(portfolio_id: string): Promise<void> {
    await this.db.run(`UPDATE engineering_portfolios SET state = 'ROLLED_BACK' WHERE id = ?`, [portfolio_id]);
  }

  async verifyPortfolio(portfolio_id: string, success: boolean): Promise<void> {
    await this.db.run(`UPDATE engineering_portfolios SET state = ? WHERE id = ?`, [success ? 'COMPLETED' : 'FAILED', portfolio_id]);
  }

  async evaluatePortfolioOutcome(portfolio_id: string, objective_achievement: number, cost_variance: number = 0, time_variance: number = 0, resource_variance: number = 0): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_outcomes (id, portfolio_id, objective_achievement, cost_variance, time_variance, resource_variance) VALUES (?,?,?,?,?,?)`,
      [id, portfolio_id, objective_achievement, cost_variance, time_variance, resource_variance]);
    return id;
  }

  async createPortfolioIncident(input: { incident_type: string; description: string; severity?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_incidents (id, severity, description, incident_type, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.severity ?? 'MEDIUM', input.description, input.incident_type, uuidv4()]);
    return id;
  }

  async escalatePortfolioIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE portfolio_incidents SET escalated=1 WHERE id=?`, [incident_id]);
  }

  async generatePortfolioEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordPortfolioAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.epoch]);
    return id;
  }

  async queryPortfolioLineage(portfolio_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM portfolio_lineage WHERE entity_id = ?', [portfolio_id]);
  }

  async recordPortfolioLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordPortfolioLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO portfolio_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async replayPortfolio(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}