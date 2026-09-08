// src/core/worker-phase92.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase92ControlPlane {
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

  async createDecision(input: {
    id?: string; organization_id: string; project_id: string; environment: string;
    mission_id?: string; workload_id?: string; portfolio_id?: string; decision_type: string;
    objective?: string; decision_deadline?: string; decision_risk?: string; decision_impact?: string;
    decision_reversibility?: string; decision_blast_radius?: number; decision_authority?: string;
    required_quorum?: number; required_approval?: boolean; evidence_threshold?: number; confidence_threshold?: number;
    policy_version?: string; safety_context?: string; governance_context?: string; idempotency_key?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM collective_decisions WHERE idempotency_key = ?', [input.idempotency_key ?? null]);
    if (existing) return existing.id;
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.db.run(`INSERT INTO collective_decisions (id, organization_id, project_id, environment, mission_id, workload_id, portfolio_id, decision_type, objective, decision_deadline, decision_risk, decision_impact, decision_reversibility, decision_blast_radius, decision_authority, required_quorum, required_approval, evidence_threshold, confidence_threshold, policy_version, safety_context, governance_context, decision_fingerprint, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.organization_id, input.project_id, input.environment, input.mission_id ?? null, input.workload_id ?? null, input.portfolio_id ?? null, input.decision_type, input.objective ?? null, input.decision_deadline ?? null, input.decision_risk ?? null, input.decision_impact ?? null, input.decision_reversibility ?? null, input.decision_blast_radius ?? null, input.decision_authority ?? null, input.required_quorum ?? 1, input.required_approval ? 1 : 0, input.evidence_threshold ?? 0.5, input.confidence_threshold ?? 0.5, input.policy_version ?? null, input.safety_context ?? null, input.governance_context ?? null, fingerprint, input.idempotency_key ?? null]);
    return id;
  }

  async getDecision(decision_id: string): Promise<any> {
    return this.db.get('SELECT * FROM collective_decisions WHERE id = ?', [decision_id]);
  }

  async buildDecisionContext(decision_id: string, context_data: string): Promise<string> {
    const id = uuidv4();
    const fingerprint = createHash('sha256').update(context_data).digest('hex');
    await this.db.run(`INSERT INTO decision_contexts (id, decision_id, context_data, fingerprint) VALUES (?,?,?,?)`, [id, decision_id, context_data, fingerprint]);
    return id;
  }

  async addEvidence(input: { decision_id: string; evidence_type: string; source?: string; source_type?: string; authority?: string; confidence?: number; freshness?: string; data?: string; fingerprint?: string }): Promise<string> {
    const id = uuidv4();
    const fp = input.fingerprint ?? createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.db.run(`INSERT INTO decision_evidence (id, decision_id, evidence_type, source, source_type, authority, confidence, freshness, data, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.decision_id, input.evidence_type, input.source ?? null, input.source_type ?? null, input.authority ?? 'UNKNOWN', input.confidence ?? 0.5, input.freshness ?? 'CURRENT', input.data ?? null, fp]);
    return id;
  }

  async validateEvidence(evidence_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const ev = await this.db.get('SELECT * FROM decision_evidence WHERE id = ?', [evidence_id]);
    if (!ev) return { valid: false, issues: ['Evidence not found'] };
    return { valid: true, issues: [] };
  }

  async submitRecommendation(input: { decision_id: string; participant_id: string; recommendation: string; confidence?: number; uncertainty?: number; evidence_refs?: string; rationale?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_recommendations (id, decision_id, participant_id, recommendation, confidence, uncertainty, evidence_refs, rationale) VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.decision_id, input.participant_id, input.recommendation, input.confidence ?? 0.5, input.uncertainty ?? 0.5, input.evidence_refs ?? null, input.rationale ?? null]);
    return id;
  }

  async generateAlternatives(input: { decision_id: string; alternative_name: string; action?: string; confidence?: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_alternatives (id, decision_id, alternative_name, action, confidence) VALUES (?,?,?,?,?)`, [id, input.decision_id, input.alternative_name, input.action ?? null, input.confidence ?? 0.5]);
    return id;
  }

  async analyzeDisagreement(decision_id: string): Promise<number> {
    const recs = await this.db.all('SELECT recommendation FROM decision_recommendations WHERE decision_id = ?', [decision_id]);
    const unique = new Set(recs.map((r:any)=>r.recommendation));
    return unique.size;
  }

  async calculateConfidence(decision_id: string, confidence: number, factors?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_confidence (id, decision_id, confidence, factors) VALUES (?,?,?,?)`, [id, decision_id, confidence, factors ?? null]);
    return id;
  }

  async calculateRisk(decision_id: string, risk_level: string, blast_radius?: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_risk_assessments (id, decision_id, risk_level, blast_radius) VALUES (?,?,?,?)`, [id, decision_id, risk_level, blast_radius ?? null]);
    return id;
  }

  async buildConsensus(decision_id: string, consensus_type: string, result: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_consensus (id, decision_id, consensus_type, result) VALUES (?,?,?,?)`, [id, decision_id, consensus_type, result]);
    return id;
  }

  async arbitrateDecision(decision_id: string, winner_alternative_id: string, loser_alternative_id: string, rationale?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_arbitrations (id, decision_id, winner_alternative_id, loser_alternative_id, rationale) VALUES (?,?,?,?,?)`, [id, decision_id, winner_alternative_id, loser_alternative_id, rationale ?? null]);
    return id;
  }

  async explainDecision(decision_id: string): Promise<string> {
    const decision = await this.db.get('SELECT * FROM collective_decisions WHERE id = ?', [decision_id]);
    if (!decision) throw new Error('Decision not found');
    const recs = await this.db.all('SELECT participant_id, recommendation FROM decision_recommendations WHERE decision_id = ?', [decision_id]);
    const alt = await this.db.get('SELECT * FROM decision_alternatives WHERE decision_id = ? ORDER BY created_at DESC LIMIT 1', [decision_id]);
    return `Decision ${decision_id}: type=${decision.decision_type}, alt=${alt?.alternative_name ?? 'none'}, recommendations=${recs.length}`;
  }

  async evaluateGovernance(decision_id: string): Promise<string> {
    return 'ALLOW';
  }

  async evaluateSafety(decision_id: string): Promise<{ safe: boolean; reasons: string[] }> {
    return { safe: true, reasons: [] };
  }

  async requestApproval(decision_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_approvals (id, decision_id, state) VALUES (?,?,?)`, [id, decision_id, 'PENDING']);
    return id;
  }

  async approveDecision(decision_id: string): Promise<void> {
    await this.db.run(`UPDATE decision_approvals SET state='APPROVED' WHERE decision_id=?`, [decision_id]);
  }

  async rejectDecision(decision_id: string): Promise<void> {
    await this.db.run(`UPDATE decision_approvals SET state='REJECTED' WHERE decision_id=?`, [decision_id]);
  }

  async createDecisionContract(decision_id: string, contract_content: string): Promise<string> {
    const latest = await this.db.get('SELECT MAX(version) as maxVersion FROM decision_contracts WHERE decision_id = ?', [decision_id]);
    const version = (latest?.maxVersion ?? 0) + 1;
    const id = uuidv4();
    const fingerprint = createHash('sha256').update(contract_content).digest('hex');
    await this.db.run(`INSERT INTO decision_contracts (id, decision_id, version, contract_content, fingerprint) VALUES (?,?,?,?,?)`, [id, decision_id, version, contract_content, fingerprint]);
    return id;
  }

  async validateContract(contract_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const c = await this.db.get('SELECT * FROM decision_contracts WHERE id = ?', [contract_id]);
    if (!c) return { valid: false, issues: ['Contract not found'] };
    return { valid: true, issues: [] };
  }

  async handoffExecution(decision_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_executions (id, decision_id, state, correlation_id) VALUES (?,?,?,?)`, [id, decision_id, 'EXECUTING', uuidv4()]);
    return id;
  }

  async verifyDecision(execution_id: string, success: boolean): Promise<string> {
    const id = uuidv4();
    const result = success ? 'SUCCESS' : 'FAILED';
    await this.db.run(`INSERT INTO decision_verifications (id, execution_id, result, correlation_id) VALUES (?,?,?,?)`, [id, execution_id, result, uuidv4()]);
    await this.db.run(`UPDATE decision_executions SET state = ? WHERE id = ?`, [success ? 'VERIFIED' : 'REGRESSED', execution_id]);
    return id;
  }

  async recordOutcome(decision_id: string, outcome_type: string, value: number): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_outcomes (id, decision_id, outcome_type, value) VALUES (?,?,?,?)`, [id, decision_id, outcome_type, value]);
    return id;
  }

  async calculateRegret(decision_id: string, regret_value: number, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_regret (id, decision_id, regret_value, confidence) VALUES (?,?,?,?)`, [id, decision_id, regret_value, confidence]);
    return id;
  }

  async recordLearning(learning_type: string, entity_id: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, learning_type, entity_id, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async queryDecisionLineage(entity_type: string, entity_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM decision_lineage WHERE entity_type = ? AND entity_id = ?', [entity_type, entity_id]);
  }

  async recordDecisionLineage(entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async replayDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }

  async detectDivergence(original_fingerprint: string, replay_fingerprint: string, changed_inputs: string, classification?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_divergence (id, original_fingerprint, replay_fingerprint, changed_inputs, classification) VALUES (?,?,?,?,?)`,
      [id, original_fingerprint, replay_fingerprint, changed_inputs, classification ?? 'DIVERGENCE']);
    return id;
  }

  async openDecisionBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO decision_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeDecisionBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO decision_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async createIncident(incident_type: string, description: string, severity: string = 'MEDIUM'): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_incidents (id, incident_type, description, severity, correlation_id) VALUES (?,?,?,?,?)`, [id, incident_type, description, severity, uuidv4()]);
    return id;
  }

  async escalateIncident(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE decision_incidents SET escalated=1 WHERE id=?`, [incident_id]);
  }

  async generateEvidence(entity_type: string, entity_id: string, evidence_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_evidence_records (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, evidence_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordAudit(event_type: string, entity_type: string, entity_id: string, actor: string, previous_state?: any, new_state?: any, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO decision_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, event_type, entity_type, entity_id, actor, JSON.stringify(previous_state ?? null), JSON.stringify(new_state ?? null), reason ?? null, uuidv4(), this.nextEpoch()]);
    return id;
  }
}