// src/core/worker-phase81.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type PolicyState = 'DRAFT' | 'PROPOSED' | 'UNDER_REVIEW' | 'APPROVED' | 'SCHEDULED' | 'ACTIVE' | 'FROZEN' | 'REJECTED' | 'EXPIRED' | 'ROLLED_BACK' | 'SUPERSEDED';
export type AutonomyClass = 'CLASS_A' | 'CLASS_B' | 'CLASS_C' | 'CLASS_D';
export type GovernanceResult = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY' | 'FREEZE';
export type SimulationResult = 'SAFE' | 'UNSAFE' | 'INCONCLUSIVE';

export class Phase81ControlPlane {
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

  async createPolicy(input: {
    id?: string; policy_name: string; policy_type: string; scope: string;
    project_id?: string; environment?: string; fleet_id?: string; region_id?: string;
    resource_class?: string; priority?: number; owner?: string; autonomy_class?: AutonomyClass;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM engineering_policies WHERE policy_name = ? AND project_id IS ? AND environment IS ?', [input.policy_name, input.project_id ?? null, input.environment ?? null]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO engineering_policies (id, policy_name, policy_type, scope, project_id, environment, fleet_id, region_id, resource_class, priority, owner, autonomy_class)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.policy_name, input.policy_type, input.scope, input.project_id ?? null, input.environment ?? null, input.fleet_id ?? null, input.region_id ?? null, input.resource_class ?? null, input.priority ?? 5, input.owner ?? null, input.autonomy_class ?? 'CLASS_A']
    );
    return id;
  }

  async createPolicyVersion(input: { policy_id: string; content?: string; constraints?: string; creator?: string; reason?: string; provenance?: string; parent_version?: number; approval_state?: string }): Promise<string> {
    const latest = await this.db.get('SELECT MAX(version) as maxVersion FROM engineering_policy_versions WHERE policy_id = ?', [input.policy_id]);
    const nextVersion = (latest?.maxVersion ?? 0) + 1;
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO engineering_policy_versions (id, policy_id, version, content, constraints, creator, reason, provenance, parent_version, approval_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.policy_id, nextVersion, input.content ?? null, input.constraints ?? null, input.creator ?? null, input.reason ?? null, input.provenance ?? null, input.parent_version ?? null, input.approval_state ?? null]
    );
    await this.db.run('UPDATE engineering_policies SET version = ?, updated_at = datetime(\'now\') WHERE id = ?', [nextVersion, input.policy_id]);
    return id;
  }

  async getPolicy(policy_id: string): Promise<any> {
    return this.db.get('SELECT * FROM engineering_policies WHERE id = ?', [policy_id]);
  }

  async evaluatePolicy(policy_id: string): Promise<{ state: PolicyState; reasons: string[] }> {
    const policy = await this.db.get('SELECT * FROM engineering_policies WHERE id = ?', [policy_id]);
    if (!policy) throw new Error('Policy not found');
    let state: PolicyState = policy.state;
    return { state, reasons: [] };
  }

  async evaluateEffectiveness(input: {
    policy_id: string; metric: string; actual_outcome: number; success_rate?: number;
    failure_rate?: number; resource_efficiency?: number; latency?: number; cost?: number;
    reliability?: number; safety_violations?: number; incidents?: number; regressions?: number;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO policy_effectiveness (id, policy_id, metric, actual_outcome, success_rate, failure_rate, resource_efficiency, latency, cost, reliability, safety_violations, incidents, regressions, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.policy_id, input.metric, input.actual_outcome, input.success_rate ?? null, input.failure_rate ?? null, input.resource_efficiency ?? null, input.latency ?? null, input.cost ?? null, input.reliability ?? null, input.safety_violations ?? null, input.incidents ?? null, input.regressions ?? null, uuidv4()]
    );
    return id;
  }

  async defineObjective(input: { policy_id: string; metric: string; target?: number; threshold?: number; direction: 'MINIMIZE'|'MAXIMIZE'; weight?: number; scope?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_objectives (id, policy_id, metric, target, threshold, direction, weight, scope) VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.policy_id, input.metric, input.target ?? null, input.threshold ?? null, input.direction, input.weight ?? 1.0, input.scope ?? null]);
    return id;
  }

  async defineConstraint(input: { policy_id: string; constraint_type: 'HARD'|'SOFT'; field: string; min_value?: number; max_value?: number; step_size?: number; rate_limit?: number; cumulative_limit?: number; description?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_constraints (id, policy_id, constraint_type, field, min_value, max_value, step_size, rate_limit, cumulative_limit, description) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.policy_id, input.constraint_type, input.field, input.min_value ?? null, input.max_value ?? null, input.step_size ?? null, input.rate_limit ?? null, input.cumulative_limit ?? null, input.description ?? null]);
    return id;
  }

  async detectConflict(input: { policy_a_id: string; policy_b_id: string; conflict_type?: string; description?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_conflicts (id, policy_a_id, policy_b_id, conflict_type, description, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.policy_a_id, input.policy_b_id, input.conflict_type ?? null, input.description ?? null, uuidv4()]);
    return id;
  }

  async generateOptimizationCandidate(input: {
    policy_id: string; parent_version: number; proposed_changes?: string; expected_benefit?: string;
    expected_risk?: string; affected_scope?: string; constraints?: string; reason?: string; evidence?: string; confidence?: number;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_optimization_candidates (id, policy_id, parent_version, proposed_changes, expected_benefit, expected_risk, affected_scope, constraints, reason, evidence, confidence, state, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.policy_id, input.parent_version, input.proposed_changes ?? null, input.expected_benefit ?? null, input.expected_risk ?? null, input.affected_scope ?? null, input.constraints ?? null, input.reason ?? null, input.evidence ?? null, input.confidence ?? null, 'PROPOSED', uuidv4()]);
    return id;
  }

  async scoreCandidate(candidate_id: string, score: number, objective_scores?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_candidate_scores (id, candidate_id, score, objective_scores) VALUES (?,?,?,?)`,
      [id, candidate_id, score, objective_scores ?? null]);
    return id;
  }

  async simulateCandidate(input: { candidate_id: string; result?: SimulationResult; expected_benefit?: string; expected_cost?: number; resource_impact?: number; workload_impact?: number; blast_radius?: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_simulations (id, candidate_id, result, expected_benefit, expected_cost, resource_impact, workload_impact, blast_radius, correlation_id) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.candidate_id, input.result ?? 'INCONCLUSIVE', input.expected_benefit ?? null, input.expected_cost ?? null, input.resource_impact ?? null, input.workload_impact ?? null, input.blast_radius ?? null, uuidv4()]);
    return id;
  }

  async evaluateGovernance(candidate_id: string): Promise<GovernanceResult> {
    const candidate = await this.db.get('SELECT * FROM policy_optimization_candidates WHERE id = ?', [candidate_id]);
    if (!candidate) return 'DENY';
    const policy = await this.db.get('SELECT * FROM engineering_policies WHERE id = ?', [candidate.policy_id]);
    if (!policy) return 'DENY';
    if (policy.autonomy_class === 'CLASS_D') return 'FREEZE';
    if (policy.autonomy_class === 'CLASS_C') return 'APPROVAL_REQUIRED';
    return 'ALLOW';
  }

  async evaluateSafety(candidate_id: string): Promise<{ safe: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const candidate = await this.db.get('SELECT * FROM policy_optimization_candidates WHERE id = ?', [candidate_id]);
    if (!candidate) reasons.push('Candidate not found');
    const sim = await this.db.get('SELECT * FROM policy_simulations WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1', [candidate_id]);
    if (!sim) reasons.push('Simulation missing');
    else if (sim.result !== 'SAFE') reasons.push(`Unsafe simulation result: ${sim.result}`);
    if (candidate && (candidate.blast_radius ?? 0) > 10) reasons.push('Blast radius too large');
    return { safe: reasons.length === 0, reasons };
  }

  async requestApproval(candidate_id: string, approver?: string, expires_at?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_approvals (id, candidate_id, approver, state, expires_at) VALUES (?,?,?,?,?)`,
      [id, candidate_id, approver ?? null, 'PENDING', expires_at ?? null]);
    return id;
  }

  async approveCandidate(candidate_id: string): Promise<void> {
    await this.db.run(`UPDATE policy_approvals SET state = 'APPROVED' WHERE candidate_id = ?`, [candidate_id]);
  }

  async rejectCandidate(candidate_id: string): Promise<void> {
    await this.db.run(`UPDATE policy_approvals SET state = 'REJECTED' WHERE candidate_id = ?`, [candidate_id]);
  }

  async activateCandidate(candidate_id: string): Promise<string> {
    const gov = await this.evaluateGovernance(candidate_id);
    if (gov === 'DENY' || gov === 'FREEZE') throw new Error('Governance not allow');
    if (gov === 'APPROVAL_REQUIRED') {
      const approval = await this.db.get('SELECT state FROM policy_approvals WHERE candidate_id = ?', [candidate_id]);
      if (!approval || approval.state !== 'APPROVED') throw new Error('Approval required');
    }
    const safety = await this.evaluateSafety(candidate_id);
    if (!safety.safe) throw new Error('Safety check failed');
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_activations (id, candidate_id, state, correlation_id) VALUES (?,?,?,?)`,
      [id, candidate_id, 'ACTIVE', uuidv4()]);
    return id;
  }

  async startCanary(activation_id: string, scope_subset?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_canaries (id, activation_id, state, scope_subset, correlation_id) VALUES (?,?,?,?,?)`,
      [id, activation_id, 'ACTIVE', scope_subset ?? null, uuidv4()]);
    return id;
  }

  async observePolicy(policy_id: string, metric: string, observed_value: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_observations (id, policy_id, metric, observed_value, correlation_id) VALUES (?,?,?,?,?)`,
      [id, policy_id, metric, observed_value, uuidv4()]);
    return id;
  }

  async verifyPolicy(activation_id: string, success: boolean): Promise<void> {
    await this.db.run(`UPDATE policy_activations SET state = ? WHERE id = ?`, [success ? 'VERIFIED' : 'FAILED', activation_id]);
  }

  async detectRegression(policy_id: string, regression_type: string, severity?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_regressions (id, policy_id, regression_type, severity, correlation_id) VALUES (?,?,?,?,?)`,
      [id, policy_id, regression_type, severity ?? 'MEDIUM', uuidv4()]);
    return id;
  }

  async detectDrift(policy_id: string, drift_type: string, details?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_drift (id, policy_id, drift_type, details, correlation_id) VALUES (?,?,?,?,?)`,
      [id, policy_id, drift_type, details ?? null, uuidv4()]);
    return id;
  }

  async rollbackPolicy(policy_id: string, from_version: number, to_version: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_rollbacks (id, policy_id, from_version, to_version, correlation_id) VALUES (?,?,?,?,?)`,
      [id, policy_id, from_version, to_version, uuidv4()]);
    await this.db.run(`UPDATE engineering_policies SET state = 'ROLLED_BACK' WHERE id = ?`, [policy_id]);
    return id;
  }

  async openOptimizationBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO policy_optimization_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeOptimizationBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO policy_optimization_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async createIncident(input: { incident_type: string; description: string; severity?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), 'INCIDENT', id, 'INCIDENT', JSON.stringify({incident_type: input.incident_type, description: input.description, severity: input.severity ?? 'MEDIUM'}), uuidv4()]);
    return id;
  }

  async escalateIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE policy_evidence SET data = json_set(data, '$.escalated', 1) WHERE entity_type='INCIDENT' AND entity_id=?`, [incident_id]);
  }

  async generateEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async queryLineage(entity_type: string, entity_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM policy_lineage WHERE entity_type = ? AND entity_id = ?', [entity_type, entity_id]);
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO policy_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async replayPolicyDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}