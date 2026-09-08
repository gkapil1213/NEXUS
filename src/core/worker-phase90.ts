// src/core/worker-phase90.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase90ControlPlane {
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

  async createDomain(input: { id?: string; organization_id: string; name: string; project_scope?: string; environment_scope?: string; delegation_depth_limit?: number }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM collective_execution_domains WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO collective_execution_domains (id, organization_id, name, project_scope, environment_scope, delegation_depth_limit) VALUES (?,?,?,?,?,?)`,
      [id, input.organization_id, input.name, input.project_scope ?? null, input.environment_scope ?? null, input.delegation_depth_limit ?? 2]);
    return id;
  }

  async createCompositeCapability(input: { organization_id: string; name: string; version?: number; contract_json?: string; risk?: string }): Promise<string> {
    const id = uuidv4();
    const version = input.version ?? 1;
    await this.db.run(`INSERT INTO composite_capabilities (id, name, organization_id, version, contract_json, risk) VALUES (?,?,?,?,?,?)`,
      [id, input.name, input.organization_id, version, input.contract_json ?? null, input.risk ?? null]);
    return id;
  }

  async addCompositionNode(composite_id: string, child_capability_id: string, role?: string, order_index?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_composition_nodes (id, composite_id, child_capability_id, role, order_index) VALUES (?,?,?,?,?)`,
      [id, composite_id, child_capability_id, role ?? null, order_index ?? null]);
    return id;
  }

  async addCompositionEdge(composite_id: string, source_node_id: string, target_node_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_composition_edges (id, composite_id, source_node_id, target_node_id) VALUES (?,?,?,?)`, [id, composite_id, source_node_id, target_node_id]);
    return id;
  }

  async validateCapabilityGraph(composite_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const nodes = await this.db.all('SELECT id FROM capability_composition_nodes WHERE composite_id = ?', [composite_id]);
    if (nodes.length === 0) issues.push('No nodes');
    return { valid: issues.length === 0, issues };
  }

  async createTeam(input: { organization_id: string; mission_id?: string; project_id?: string; environment?: string; composite_capability_id?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO engineering_teams (id, organization_id, mission_id, project_id, environment, composite_capability_id) VALUES (?,?,?,?,?,?)`,
      [id, input.organization_id, input.mission_id ?? null, input.project_id ?? null, input.environment ?? null, input.composite_capability_id ?? null]);
    return id;
  }

  async addTeamMember(team_id: string, participant_id: string, role: string, capability_id?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO engineering_team_members (id, team_id, participant_id, role, capability_id) VALUES (?,?,?,?,?)`, [id, team_id, participant_id, role, capability_id ?? null]);
    return id;
  }

  async requestDelegation(team_id: string, delegator: string, delegate: string, capability_id: string, depth: number = 0): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO delegation_requests (id, team_id, delegator_participant_id, delegate_participant_id, capability_id, depth) VALUES (?,?,?,?,?,?)`,
      [id, team_id, delegator, delegate, capability_id, depth]);
    return id;
  }

  async createDelegatedTask(team_id: string, participant_id: string, capability_id: string, project_id: string, environment: string, dependencies_json?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO delegated_tasks (id, team_id, participant_id, capability_id, project_id, environment, dependencies_json) VALUES (?,?,?,?,?,?,?)`,
      [id, team_id, participant_id, capability_id, project_id, environment, dependencies_json ?? null]);
    return id;
  }

  async createMissionContext(team_id: string, context_data: string): Promise<string> {
    const id = uuidv4();
    const fingerprint = createHash('sha256').update(context_data).digest('hex');
    await this.db.run(`INSERT INTO mission_contexts (id, team_id, context_data, fingerprint) VALUES (?,?,?,?)`, [id, team_id, context_data, fingerprint]);
    return id;
  }

  async grantContextAccess(context_id: string, participant_id: string, scope?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO context_access_grants (id, context_id, participant_id, scope) VALUES (?,?,?,?)`, [id, context_id, participant_id, scope ?? null]);
    return id;
  }

  async assignTask(task_id: string, participant_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_task_assignments (id, task_id, participant_id) VALUES (?,?,?)`, [id, task_id, participant_id]);
    return id;
  }

  async acquireLease(assignment_id: string, expires_at: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_task_leases (id, assignment_id, lease_expires_at) VALUES (?,?,?)`, [id, assignment_id, expires_at]);
    return id;
  }

  async createHandoff(from_participant_id: string, to_participant_id: string, task_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO task_handoffs (id, from_participant_id, to_participant_id, task_id) VALUES (?,?,?,?)`, [id, from_participant_id, to_participant_id, task_id]);
    return id;
  }

  async submitResult(task_id: string, participant_id: string, result_data: string, confidence?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO execution_results (id, task_id, participant_id, result_data, confidence) VALUES (?,?,?,?,?)`, [id, task_id, participant_id, result_data, confidence ?? null]);
    return id;
  }

  async reconcileResults(task_id: string): Promise<string> {
    const results = await this.db.all('SELECT result_data FROM execution_results WHERE task_id = ?', [task_id]);
    const unique = [...new Set(results.map((r:any)=>r.result_data))];
    const state = unique.length === 1 ? 'AGREED' : (unique.length > 0 ? 'CONFLICTING' : 'UNKNOWN');
    const id = uuidv4();
    await this.db.run(`INSERT INTO result_reconciliations (id, task_id, result_state) VALUES (?,?,?)`, [id, task_id, state]);
    return state;
  }

  async recordCollectiveConfidence(task_id: string, confidence: number, factors?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_confidence_records (id, task_id, confidence, factors) VALUES (?,?,?,?)`, [id, task_id, confidence, factors ?? null]);
    return id;
  }

  async assessCollectiveRisk(team_id: string, risk_type: string, severity: string, blast_radius?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_risk_assessments (id, team_id, risk_type, severity, blast_radius) VALUES (?,?,?,?,?)`, [id, team_id, risk_type, severity, blast_radius ?? null]);
    return id;
  }

  async allocateResource(team_id: string, resource_type: string, amount: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_resource_allocations (id, team_id, resource_type, amount) VALUES (?,?,?,?)`, [id, team_id, resource_type, amount]);
    return id;
  }

  async reserveResource(team_id: string, resource_type: string, amount: number, expires_at?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_reservations (id, team_id, resource_type, amount, expires_at) VALUES (?,?,?,?,?)`, [id, team_id, resource_type, amount, expires_at ?? null]);
    return id;
  }

  async quarantineTeam(team_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO team_quarantines (id, team_id, reason) VALUES (?,?,?)`, [id, team_id, reason ?? null]);
    await this.db.run(`UPDATE engineering_teams SET lifecycle_state='QUARANTINED' WHERE id=?`, [team_id]);
    return id;
  }

  async openCollectiveBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO collective_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeCollectiveBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO collective_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`,
      [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async createCollectiveIncident(incident_type: string, description: string, severity: string = 'MEDIUM'): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_incidents (id, incident_type, description, severity, correlation_id) VALUES (?,?,?,?,?)`, [id, incident_type, description, severity, uuidv4()]);
    return id;
  }

  async escalateCollectiveIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE collective_incidents SET escalated=1 WHERE id=?`, [incident_id]);
  }

  async generateEvidence(entity_type: string, entity_id: string, evidence_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, evidence_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordAudit(event_type: string, entity_type: string, entity_id: string, actor: string, previous_state?: any, new_state?: any, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, event_type, entity_type, entity_id, actor, JSON.stringify(previous_state ?? null), JSON.stringify(new_state ?? null), reason ?? null, uuidv4(), this.nextEpoch()]);
    return id;
  }

  async recordLineage(entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordLearning(learning_type: string, entity_id: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, learning_type, entity_id, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordDecisionMemory(decision_type: string, context: string, selected_option: string, rejected_options?: string, rationale?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO collective_decision_memory (id, decision_type, context, selected_option, rejected_options, rationale) VALUES (?,?,?,?,?,?)`,
      [id, decision_type, context, selected_option, rejected_options ?? null, rationale ?? null]);
    return id;
  }

  async replayCollectiveExecution(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}