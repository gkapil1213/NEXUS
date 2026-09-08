// src/core/worker-phase91.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase91ControlPlane {
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

  async createNegotiationSession(input: {
    id?: string; organization_id: string; project_id: string; environment: string;
    mission_id?: string; workload_id?: string; collective_id?: string;
    required_capabilities?: string; resource_requirements?: string; deadline?: string;
    risk_classification?: string; governance_context?: string; safety_context?: string;
    approval_required?: boolean; idempotency_key?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM collective_negotiation_sessions WHERE idempotency_key = ?', [input.idempotency_key ?? null]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO collective_negotiation_sessions (id, organization_id, project_id, environment, mission_id, workload_id, collective_id, required_capabilities, resource_requirements, deadline, risk_classification, governance_context, safety_context, approval_required, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.organization_id, input.project_id, input.environment, input.mission_id ?? null, input.workload_id ?? null, input.collective_id ?? null, input.required_capabilities ?? null, input.resource_requirements ?? null, input.deadline ?? null, input.risk_classification ?? null, input.governance_context ?? null, input.safety_context ?? null, input.approval_required ? 1 : 0, input.idempotency_key ?? null]);
    return id;
  }

  async addParticipant(input: { session_id: string; participant_id: string; role?: string; capability_id?: string; trust_level?: string; authorization_ref?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_participants (id, session_id, participant_id, role, capability_id, trust_level, authorization_ref) VALUES (?,?,?,?,?,?,?)`,
      [id, input.session_id, input.participant_id, input.role ?? null, input.capability_id ?? null, input.trust_level ?? 'UNKNOWN', input.authorization_ref ?? null]);
    return id;
  }

  async submitProposal(input: {
    session_id: string; proposer_participant_id: string; proposal_type: string;
    target_participant_id?: string; content?: string; constraints?: string; assumptions?: string;
    expected_utility?: number; expected_risk?: number; confidence?: number; expiry?: string; parent_proposal_id?: string;
  }): Promise<string> {
    const id = uuidv4();
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.db.run(`INSERT INTO negotiation_proposals (id, session_id, proposer_participant_id, proposal_type, target_participant_id, content, constraints, assumptions, expected_utility, expected_risk, confidence, expiry, parent_proposal_id, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.session_id, input.proposer_participant_id, input.proposal_type, input.target_participant_id ?? null, input.content ?? null, input.constraints ?? null, input.assumptions ?? null, input.expected_utility ?? null, input.expected_risk ?? null, input.confidence ?? null, input.expiry ?? null, input.parent_proposal_id ?? null, fingerprint]);
    return id;
  }

  async counterProposal(proposal_id: string, counteroffer_content: string): Promise<string> {
    const id = uuidv4();
    const offer = await this.db.get('SELECT id FROM negotiation_offers WHERE proposal_id = ? LIMIT 1', [proposal_id]);
    let offerId = offer?.id;
    if (!offerId) {
      offerId = uuidv4();
      await this.db.run(`INSERT INTO negotiation_offers (id, session_id, proposal_id, offer_content) SELECT ?, session_id, ?, ? FROM negotiation_proposals WHERE id=?`, [offerId, proposal_id, 'original', proposal_id]);
    }
    await this.db.run(`INSERT INTO negotiation_counteroffers (id, offer_id, counteroffer_content) VALUES (?,?,?)`, [id, offerId, counteroffer_content]);
    return id;
  }

  async evaluateConstraints(session_id: string): Promise<{ valid: boolean; issues: string[] }> {
    return { valid: true, issues: [] };
  }

  async calculateUtility(session_id: string): Promise<number> {
    return 0.8;
  }

  async evaluateTrust(participant_id: string): Promise<string> {
    return 'MEDIUM';
  }

  async evaluateFairness(session_id: string): Promise<number> {
    return 0.7;
  }

  async arbitrateNegotiation(session_id: string, winner_proposal_id: string, loser_proposal_id: string, rationale?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_arbitrations (id, session_id, winner_proposal_id, loser_proposal_id, rationale) VALUES (?,?,?,?,?)`, [id, session_id, winner_proposal_id, loser_proposal_id, rationale ?? null]);
    return id;
  }

  async acceptProposal(proposal_id: string): Promise<void> {
    await this.db.run(`UPDATE negotiation_proposals SET state='ACCEPTED' WHERE id=?`, [proposal_id]);
  }

  async rejectProposal(proposal_id: string): Promise<void> {
    await this.db.run(`UPDATE negotiation_proposals SET state='REJECTED' WHERE id=?`, [proposal_id]);
  }

  async createContract(session_id: string, contract_content: string): Promise<string> {
    const latest = await this.db.get('SELECT MAX(version) as maxVersion FROM negotiation_contracts WHERE session_id = ?', [session_id]);
    const nextVersion = (latest?.maxVersion ?? 0) + 1;
    const id = uuidv4();
    const fingerprint = createHash('sha256').update(contract_content).digest('hex');
    await this.db.run(`INSERT INTO negotiation_contracts (id, session_id, version, contract_content, fingerprint) VALUES (?,?,?,?,?)`, [id, session_id, nextVersion, contract_content, fingerprint]);
    return id;
  }

  async amendContract(contract_id: string, new_content: string): Promise<string> {
    const old = await this.db.get('SELECT * FROM negotiation_contracts WHERE id=?', [contract_id]);
    if (!old) throw new Error('Contract not found');
    const newId = uuidv4();
    await this.db.run(`INSERT INTO negotiation_contracts (id, session_id, version, contract_content, fingerprint) VALUES (?,?,?,?,?)`,
      [newId, old.session_id, old.version + 1, new_content, createHash('sha256').update(new_content).digest('hex')]);
    return newId;
  }

  async validateContract(contract_id: string): Promise<{ valid: boolean; issues: string[] }> {
    const c = await this.db.get('SELECT * FROM negotiation_contracts WHERE id=?', [contract_id]);
    if (!c) return { valid: false, issues: ['Contract not found'] };
    return { valid: true, issues: [] };
  }

  async renegotiate(session_id: string, reason: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`UPDATE collective_negotiation_sessions SET state='RENEGOTIATION_REQUIRED' WHERE id=?`, [session_id]);
    await this.db.run(`INSERT INTO negotiation_escalations (id, session_id, reason, level) VALUES (?,?,?,?)`, [id, session_id, reason, 'AUTO']);
    return id;
  }

  async replaceParticipant(session_id: string, old_participant_id: string, new_participant_id: string): Promise<void> {
    await this.db.run(`UPDATE negotiation_participants SET participant_id=? WHERE session_id=? AND participant_id=?`, [new_participant_id, session_id, old_participant_id]);
  }

  async detectDeadlock(session_id: string, deadlock_type: string, description?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_deadlocks (id, session_id, deadlock_type, description) VALUES (?,?,?,?)`, [id, session_id, deadlock_type, description ?? null]);
    return id;
  }

  async escalateNegotiation(session_id: string, reason: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_escalations (id, session_id, reason, level) VALUES (?,?,?,?)`, [id, session_id, reason, 'HUMAN']);
    return id;
  }

  async replayNegotiation(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }

  async generateNegotiationEvidence(entity_type: string, entity_id: string, evidence_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, evidence_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async queryNegotiationLineage(entity_type: string, entity_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM negotiation_lineage WHERE entity_type=? AND entity_id=?', [entity_type, entity_id]);
  }

  async recordNegotiationLineage(entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordNegotiationLearning(learning_type: string, entity_id: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO negotiation_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, learning_type, entity_id, JSON.stringify(data), uuidv4()]);
    return id;
  }
}