// src/core/worker-phase93.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase93ControlPlane {
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

  async recordMemory(input: {
    id?: string; memory_type: string; subject: string; scope?: string; organization_id?: string;
    project_id?: string; environment?: string; source?: string; source_authority?: string;
    observed_at?: string; confidence?: number; freshness?: string; provenance?: string;
    content_fingerprint?: string; idempotency_key?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM engineering_memories WHERE idempotency_key = ?', [input.idempotency_key ?? null]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO engineering_memories (id, memory_type, subject, scope, organization_id, project_id, environment, source, source_authority, observed_at, confidence, freshness, provenance, content_fingerprint, idempotency_key, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.memory_type, input.subject, input.scope ?? null, input.organization_id ?? null, input.project_id ?? null, input.environment ?? null, input.source ?? null, input.source_authority ?? 'UNKNOWN', input.observed_at ?? null, input.confidence ?? 0.5, input.freshness ?? 'CURRENT', input.provenance ?? null, input.content_fingerprint ?? createHash('sha256').update(JSON.stringify(input)).digest('hex'), input.idempotency_key ?? null, uuidv4()]);
    return id;
  }

  async createEpisode(input: { organization_id?: string; project_id?: string; environment?: string; workload_id?: string; mission_id?: string; episode_type?: string; participants?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO engineering_episodes (id, organization_id, project_id, environment, workload_id, mission_id, episode_type, participants) VALUES (?,?,?,?,?,?,?,?)`,
      [id, input.organization_id ?? null, input.project_id ?? null, input.environment ?? null, input.workload_id ?? null, input.mission_id ?? null, input.episode_type ?? null, input.participants ?? null]);
    return id;
  }

  async finalizeEpisode(episode_id: string, outcome: string): Promise<void> {
    await this.db.run(`UPDATE engineering_episodes SET state='CLOSED', outcome=? WHERE id=?`, [outcome, episode_id]);
  }

  async validateMemory(memory_id: string, valid: boolean): Promise<void> {
    await this.db.run(`UPDATE engineering_memories SET status=? WHERE id=?`, [valid ? 'VALIDATED' : 'REJECTED', memory_id]);
  }

  async retrieveMemory(query_context: string): Promise<any[]> {
    const rows = await this.db.all('SELECT * FROM engineering_memories');
    const freshnessRank: Record<string, number> = { 'CURRENT': 4, 'AGING': 3, 'STALE': 2, 'EXPIRED': 1 };
    return rows
      .filter((r: any) => r.subject.includes(query_context) || r.memory_type.includes(query_context))
      .sort((a: any, b: any) => {
        const fa = freshnessRank[a.freshness ?? ''] ?? 0;
        const fb = freshnessRank[b.freshness ?? ''] ?? 0;
        if (fa !== fb) return fb - fa;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      });
  }

  async createPattern(input: { pattern_type: string; description?: string; organization_id?: string; project_id?: string; environment?: string; confidence?: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_patterns (id, pattern_type, description, organization_id, project_id, environment, confidence) VALUES (?,?,?,?,?,?,?)`,
      [id, input.pattern_type, input.description ?? null, input.organization_id ?? null, input.project_id ?? null, input.environment ?? null, input.confidence ?? 0.5]);
    return id;
  }

  async validatePattern(pattern_id: string, valid: boolean): Promise<void> {
    await this.db.run(`UPDATE memory_patterns SET validation_state=? WHERE id=?`, [valid ? 'VALIDATED' : 'INVALID', pattern_id]);
  }

  async activatePattern(pattern_id: string): Promise<void> {
    await this.db.run(`UPDATE memory_patterns SET status='ACTIVE' WHERE id=?`, [pattern_id]);
  }

  async quarantineMemory(memory_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_quarantine (id, entity_type, entity_id, reason) VALUES (?,?,?,?)`, [id, 'MEMORY', memory_id, reason ?? null]);
    await this.db.run(`UPDATE engineering_memories SET status='QUARANTINED' WHERE id=?`, [memory_id]);
    return id;
  }

  async quarantineProcedure(procedure_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_quarantine (id, entity_type, entity_id, reason) VALUES (?,?,?,?)`, [id, 'PROCEDURE', procedure_id, reason ?? null]);
    await this.db.run(`UPDATE procedural_memories SET status='QUARANTINED' WHERE id=?`, [procedure_id]);
    return id;
  }
  async quarantinePattern(pattern_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_quarantine (id, entity_type, entity_id, reason) VALUES (?,?,?,?)`, [id, 'PATTERN', pattern_id, reason ?? null]);
    await this.db.run(`UPDATE memory_patterns SET status='QUARANTINED' WHERE id=?`, [pattern_id]);
    return id;
  }

  async createProcedure(input: { procedure_name: string; preconditions?: string; required_capabilities?: string; expected_outcome?: string; observed_success_rate?: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO procedural_memories (id, procedure_name, preconditions, required_capabilities, expected_outcome, observed_success_rate) VALUES (?,?,?,?,?,?)`,
      [id, input.procedure_name, input.preconditions ?? null, input.required_capabilities ?? null, input.expected_outcome ?? null, input.observed_success_rate ?? null]);
    return id;
  }

  async detectConflict(memory_a_id: string, memory_b_id: string, conflict_type: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_conflicts (id, memory_a_id, memory_b_id, conflict_type) VALUES (?,?,?,?)`, [id, memory_a_id, memory_b_id, conflict_type]);
    return id;
  }

  async reconcileMemory(conflict_id: string, resolution_action: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_reconciliations (id, conflict_id, resolution_action) VALUES (?,?,?)`, [id, conflict_id, resolution_action]);
    await this.db.run(`UPDATE memory_conflicts SET resolution_state='RESOLVED', resolution_action=? WHERE id=?`, [resolution_action, conflict_id]);
    return id;
  }

  async extractLearning(memory_id: string, pattern_type: string, content: string, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO learning_candidates (id, memory_id, pattern_type, candidate_content, confidence) VALUES (?,?,?,?,?)`, [id, memory_id, pattern_type, content, confidence]);
    return id;
  }

  async validateLearning(candidate_id: string, valid: boolean): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO learning_validations (id, candidate_id, validation_result) VALUES (?,?,?)`, [id, candidate_id, valid ? 'VALID' : 'INVALID']);
    await this.db.run(`UPDATE learning_candidates SET state=? WHERE id=?`, [valid ? 'VALIDATED' : 'REJECTED', candidate_id]);
    return id;
  }

  async generateRecommendation(context: string, confidence: number = 0.5): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_retrievals (id, query_context, retrieved_memory_id, similarity_score) VALUES (?,?,?,?)`, [id, context, 'recommendation', confidence]);
    return id;
  }

  async generateOrganizationalInsight(organization_id: string, insight_type: string, description: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_patterns (id, pattern_type, description, organization_id) VALUES (?,?,?,?)`, [id, insight_type, description, organization_id]);
    return id;
  }

  async openLearningBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO learning_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeLearningBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO learning_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async replayMemoryDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }

  async queryMemoryLineage(entity_type: string, entity_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM memory_lineage WHERE entity_type=? AND entity_id=?', [entity_type, entity_id]);
  }

  async recordMemoryLineage(entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async generateMemoryEvidence(entity_type: string, entity_id: string, evidence_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, evidence_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordAudit(event_type: string, entity_type: string, entity_id: string, actor: string, previous_state?: any, new_state?: any, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO memory_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, event_type, entity_type, entity_id, actor, JSON.stringify(previous_state ?? null), JSON.stringify(new_state ?? null), reason ?? null, uuidv4(), this.nextEpoch()]);
    return id;
  }
}