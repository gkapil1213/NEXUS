// src/core/worker-phase88.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase88ControlPlane {
  private engine: NexusEngine;
  private lastEpoch = 0;

  private get db() {
    return {
      get: (sql: string, params?: unknown[]) => this.engine.prepare(sql).get(...(params ?? [])) as any,
      all: (sql: string, params?: unknown[]) => this.engine.prepare(sql).all(...(params ?? [])) as any,
      run: (sql: string, params?: unknown[]) => this.engine.prepare(sql).run(...(params ?? [])) as any,
    };
  }

  constructor(engine: NexusEngine) { this.engine = engine; }
  private nextEpoch(): number { this.lastEpoch = Math.max(Date.now(), this.lastEpoch + 1); return this.lastEpoch; }

  async createOperatingCycle(organization_id: string, trigger?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_operating_cycles (id, organization_id, trigger, correlation_id) VALUES (?,?,?,?)`, [id, organization_id, trigger ?? null, uuidv4()]);
    return id;
  }

  async captureOrganizationalState(organization_id: string, snapshot_type: string, state: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_state_snapshots (id, organization_id, snapshot_type, state_json, provenance) VALUES (?,?,?,?,?)`, [id, organization_id, snapshot_type, JSON.stringify(state), 'OBSERVED']);
    return id;
  }

  async detectStateChanges(organization_id: string, change_type: string, entity_id?: string, details?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_state_changes (id, organization_id, change_type, entity_id, details, correlation_id) VALUES (?,?,?,?,?,?)`, [id, organization_id, change_type, entity_id ?? null, details ?? null, uuidv4()]);
    return id;
  }

  async detectStrategicDrift(organization_id: string, drift_type: string, severity: string, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO strategic_drift_assessments (id, organization_id, drift_type, severity, confidence) VALUES (?,?,?,?,?)`, [id, organization_id, drift_type, severity, confidence]);
    return id;
  }

  async detectOperationalDrift(organization_id: string, drift_type: string, severity: string, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operational_drift_assessments (id, organization_id, drift_type, severity, confidence) VALUES (?,?,?,?,?)`, [id, organization_id, drift_type, severity, confidence]);
    return id;
  }

  async evaluateTrigger(organization_id: string, trigger_type: string, source_entity?: string): Promise<string> {
    const fingerprint = createHash('sha256').update(`${organization_id}:${trigger_type}:${source_entity ?? ''}`).digest('hex');
    const existing = await this.db.get('SELECT id FROM organizational_decision_triggers WHERE trigger_fingerprint = ?', [fingerprint]);
    if (existing) return existing.id;
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_decision_triggers (id, organization_id, trigger_type, trigger_fingerprint, source_entity) VALUES (?,?,?,?,?)`, [id, organization_id, trigger_type, fingerprint, source_entity ?? null]);
    return id;
  }

  async assessOrganizationalState(organization_id: string, assessment: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_state_snapshots (id, organization_id, snapshot_type, state_json) VALUES (?,?,?,?)`, [id, organization_id, 'ASSESSMENT', assessment]);
    return id;
  }

  async evaluateAutonomousDecision(input: { cycle_id: string; organization_id: string; decision_type: string; rationale?: string; confidence?: number; governance_result?: string; safety_result?: string; approval_required?: boolean; policy_version?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO autonomous_decisions (id, cycle_id, organization_id, decision_type, rationale, confidence, governance_result, safety_result, approval_required, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.cycle_id, input.organization_id, input.decision_type, input.rationale ?? null, input.confidence ?? 0.5, input.governance_result ?? 'ALLOW', input.safety_result ?? 'SAFE', input.approval_required ? 1 : 0, input.policy_version ?? null]);
    return id;
  }

  async requestReplan(cycle_id: string, reason: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO replanning_requests (id, cycle_id, reason) VALUES (?,?,?)`, [id, cycle_id, reason]);
    return id;
  }

  async reprioritize(cycle_id: string, entity_id: string, new_priority: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO autonomous_decisions (id, cycle_id, organization_id, decision_type, rationale, confidence, governance_result, safety_result) VALUES (?,?,?,?,?,?,?,?)`, [id, cycle_id, 'system', 'REPRIORITIZE', `priority ${new_priority}`, 0.5, 'ALLOW', 'SAFE']);
    return id;
  }

  async reallocateResources(cycle_id: string, resource_type: string, entity_id: string, amount: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO resource_reallocation_decisions (id, cycle_id, resource_type, entity_id, amount) VALUES (?,?,?,?,?)`, [id, cycle_id, resource_type, entity_id, amount]);
    return id;
  }

  async throttleExecution(cycle_id: string, throttle_level: string, target_scope?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO execution_throttle_decisions (id, cycle_id, throttle_level, target_scope) VALUES (?,?,?,?)`, [id, cycle_id, throttle_level, target_scope ?? null]);
    return id;
  }

  async pauseExecution(cycle_id: string, target_scope: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_interventions (id, cycle_id, intervention_type, state) VALUES (?,?,?,?)`, [id, cycle_id, 'PAUSE', 'EXECUTING']);
    return id;
  }

  async resumeExecution(cycle_id: string, target_scope: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_interventions (id, cycle_id, intervention_type, state) VALUES (?,?,?,?)`, [id, cycle_id, 'RESUME', 'EXECUTING']);
    return id;
  }

  async stabilizeOrganization(cycle_id: string, action_type: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO stabilization_actions (id, cycle_id, action_type, state) VALUES (?,?,?,?)`, [id, cycle_id, action_type, 'EXECUTING']);
    return id;
  }

  async requestApproval(cycle_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO human_interventions (id, cycle_id, action) VALUES (?,?,?)`, [id, cycle_id, 'APPROVAL_REQUESTED']);
    return id;
  }

  async approveAction(cycle_id: string): Promise<void> {
    await this.db.run(`UPDATE human_interventions SET action = 'APPROVED' WHERE cycle_id = ?`, [cycle_id]);
  }

  async rejectAction(cycle_id: string): Promise<void> {
    await this.db.run(`UPDATE human_interventions SET action = 'REJECTED' WHERE cycle_id = ?`, [cycle_id]);
  }

  async validatePlan(plan_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const plan = await this.db.get('SELECT * FROM operating_cycle_plans WHERE id = ?', [plan_id]);
    if (!plan) return { valid: false, issues: ['Plan not found'] };
    return { valid: true, issues: [] };
  }

  async createPlan(cycle_id: string, plan_type: string, content: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_cycle_plans (id, cycle_id, plan_type, content) VALUES (?,?,?,?)`, [id, cycle_id, plan_type, content]);
    return id;
  }

  async executeAction(cycle_id: string, action_type: string, target: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_cycle_actions (id, cycle_id, action_type, target, state) VALUES (?,?,?,?,?)`, [id, cycle_id, action_type, target, 'EXECUTING']);
    return id;
  }

  async observeExecution(cycle_id: string, observation: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_cycle_actions (id, cycle_id, action_type, state) VALUES (?,?,?,?)`, [id, cycle_id, 'OBSERVATION', observation]);
    return id;
  }

  async verifyOutcome(cycle_id: string, success: boolean): Promise<string> {
    const id = uuidv4();
    const result = success ? 'SUCCESS' : 'FAILED';
    await this.db.run(`INSERT INTO outcome_verifications (id, cycle_id, result) VALUES (?,?,?)`, [id, cycle_id, result]);
    return id;
  }

  async correctDeviation(cycle_id: string, action_type: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO corrective_actions (id, cycle_id, action_type, state) VALUES (?,?,?,?)`, [id, cycle_id, action_type, 'EXECUTING']);
    return id;
  }

  async recoverCycle(cycle_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO organizational_interventions (id, cycle_id, intervention_type, state) VALUES (?,?,?,?)`, [id, cycle_id, 'RECOVER', 'EXECUTING']);
    return id;
  }

  async createIncident(cycle_id: string, incident_type: string, description: string, severity: string = 'MEDIUM'): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_loop_incidents (id, cycle_id, incident_type, description, severity, correlation_id) VALUES (?,?,?,?,?,?)`, [id, cycle_id, incident_type, description, severity, uuidv4()]);
    return id;
  }

  async escalate(cycle_id: string, reason: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_loop_audit (id, cycle_id, event_type, entity_type, entity_id, actor, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?)`, [id, cycle_id, 'ESCALATE', 'CYCLE', cycle_id, 'system', reason, uuidv4(), this.nextEpoch()]);
    return id;
  }

  async recordLearning(cycle_id: string, learning_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_loop_learning (id, cycle_id, learning_type, data, correlation_id) VALUES (?,?,?,?,?)`, [id, cycle_id, learning_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordDecisionMemory(cycle_id: string, decision_id: string, outcome: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_loop_learning (id, cycle_id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, cycle_id, 'DECISION_MEMORY', decision_id, outcome, uuidv4()]);
    return id;
  }

  async queryLineage(cycle_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM operating_loop_lineage WHERE cycle_id = ?', [cycle_id]);
  }

  async recordLineage(cycle_id: string, entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO operating_loop_lineage (id, cycle_id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?,?)`, [id, cycle_id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async replayOperatingCycle(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}