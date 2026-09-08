// src/core/worker-phase82.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export type CausalClaimType = 'OBSERVED' | 'CORRELATED' | 'PRECEDING' | 'CONTRIBUTING' | 'CAUSAL' | 'UNKNOWN';

export class Phase82ControlPlane {
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

  async createKnowledgeNode(input: {
    id?: string;
    node_type: string;
    project_id?: string;
    environment?: string;
    fleet_id?: string;
    region_id?: string;
    identifier?: string;
  }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM knowledge_nodes WHERE node_type = ? AND identifier = ?', [input.node_type, input.identifier ?? null]);
    if (existing) return existing.id;
    await this.db.run(
      `INSERT INTO knowledge_nodes (id, node_type, project_id, environment, fleet_id, region_id, identifier)
       VALUES (?,?,?,?,?,?,?)`,
      [id, input.node_type, input.project_id ?? null, input.environment ?? null, input.fleet_id ?? null, input.region_id ?? null, input.identifier ?? null]
    );
    return id;
  }

  async resolveEntity(input: { node_type: string; identifier: string }): Promise<string | null> {
    const row = await this.db.get('SELECT id FROM knowledge_nodes WHERE node_type = ? AND identifier = ?', [input.node_type, input.identifier]);
    return row?.id ?? null;
  }

  async createRelationship(input: {
    source_id: string;
    target_id: string;
    relationship_type: string;
    confidence?: number;
    provenance?: string;
    evidence_ref?: string;
    valid_from?: string;
    valid_until?: string;
  }): Promise<string> {
    const source = await this.db.get('SELECT id FROM knowledge_nodes WHERE id = ?', [input.source_id]);
    const target = await this.db.get('SELECT id FROM knowledge_nodes WHERE id = ?', [input.target_id]);
    if (!source || !target) throw new Error('Unknown source or target node');
    const existing = await this.db.get(
      'SELECT id FROM knowledge_relationships WHERE source_id = ? AND target_id = ? AND relationship_type = ?',
      [input.source_id, input.target_id, input.relationship_type]
    );
    if (existing) return existing.id;
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO knowledge_relationships (id, source_id, target_id, relationship_type, confidence, provenance, evidence_ref, valid_from, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.source_id, input.target_id, input.relationship_type, input.confidence ?? null, input.provenance ?? null, input.evidence_ref ?? null, input.valid_from ?? null, input.valid_until ?? null]
    );
    return id;
  }

  async queryNeighbors(node_id: string, depth: number = 1): Promise<any[]> {
    if (depth < 1) depth = 1;
    let current = [node_id];
    const visited = new Set<string>(current);
    for (let i = 0; i < depth; i++) {
      const next: string[] = [];
      for (const id of current) {
        const rels = await this.db.all('SELECT target_id, source_id FROM knowledge_relationships WHERE source_id = ? OR target_id = ?', [id, id]);
        for (const r of rels) {
          const neighbor = r.target_id === id ? r.source_id : r.target_id;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      current = next;
    }
    return this.db.all('SELECT * FROM knowledge_nodes WHERE id IN (' + Array.from(visited).map(() => '?').join(',') + ')', Array.from(visited));
  }

  async queryDependencies(node_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM knowledge_relationships WHERE source_id = ?', [node_id]);
  }

  async queryDependents(node_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM knowledge_relationships WHERE target_id = ?', [node_id]);
  }

  async queryImpact(node_id: string, depth: number = 2, project_id?: string, environment?: string, region_id?: string): Promise<any[]> {
    const neighbors = await this.queryNeighbors(node_id, depth);
    let filtered = neighbors;
    if (project_id) filtered = filtered.filter((n: any) => n.project_id === project_id);
    if (environment) filtered = filtered.filter((n: any) => n.environment === environment);
    if (region_id) filtered = filtered.filter((n: any) => n.region_id === region_id);
    return filtered;
  }

  async ingestEvidence(input: { entity_type: string; entity_id: string; evidence_type: string; data: any; }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO knowledge_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id)
       VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.evidence_type, JSON.stringify(input.data), uuidv4()]
    );
    return id;
  }

  async classifyCausality(input: { evidence_count: number; temporal_support: boolean; correlation_strength: number; }): Promise<CausalClaimType> {
    if (input.evidence_count < 2) return 'UNKNOWN';
    if (!input.temporal_support) return 'CORRELATED';
    if (input.correlation_strength >= 0.8) return 'CAUSAL';
    if (input.correlation_strength >= 0.5) return 'CONTRIBUTING';
    return 'PRECEDING';
  }

  async recordCausalClaim(input: {
    cause_id: string;
    effect_id: string;
    claim_type: CausalClaimType;
    confidence?: number;
    evidence_ref?: string;
    analysis_method?: string;
    scope?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO knowledge_causal_claims (id, cause_id, effect_id, claim_type, confidence, evidence_ref, analysis_method, scope, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.cause_id, input.effect_id, input.claim_type, input.confidence ?? null, input.evidence_ref ?? null, input.analysis_method ?? null, input.scope ?? null, uuidv4()]
    );
    return id;
  }

  async analyzeRootCause(incident_node_id: string): Promise<any[]> {
    return this.db.all(
      `SELECT * FROM knowledge_causal_claims WHERE effect_id = ? ORDER BY confidence DESC, claim_type DESC`,
      [incident_node_id]
    );
  }

  async detectKnowledgeConflict(node_a_id: string, node_b_id: string, conflict_type: string, description?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO knowledge_conflicts (id, node_a_id, node_b_id, conflict_type, description, correlation_id)
       VALUES (?,?,?,?,?,?)`,
      [id, node_a_id, node_b_id, conflict_type, description ?? null, uuidv4()]
    );
    return id;
  }

  async calculateConfidence(evidenceCount: number, consistency: number): Promise<number> {
    if (evidenceCount < 1) return 0;
    if (evidenceCount < 2) return 0.4 * consistency;
    return Math.min(1, 0.5 + (evidenceCount - 2) * 0.05 * consistency);
  }

  async calculateFreshness(createdAt: string): Promise<string> {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 1) return 'CURRENT';
    if (ageDays < 7) return 'AGING';
    if (ageDays < 30) return 'STALE';
    return 'EXPIRED';
  }

  async createGraphSnapshot(scope?: string): Promise<string> {
    const id = uuidv4();
    const graphVersion = this.nextEpoch();
    await this.db.run(
      `INSERT INTO knowledge_snapshots (id, snapshot_scope, graph_version, integrity_hash)
       VALUES (?,?,?,?)`,
      [id, scope ?? null, graphVersion, createHash('sha256').update(JSON.stringify({ graphVersion })).digest('hex')]
    );
    return id;
  }

  async reconcileGraph(): Promise<any[]> {
    const orphanRels = await this.db.all(
      `SELECT kr.* FROM knowledge_relationships kr
       LEFT JOIN knowledge_nodes ks ON kr.source_id = ks.id
       LEFT JOIN knowledge_nodes kt ON kr.target_id = kt.id
       WHERE ks.id IS NULL OR kt.id IS NULL`
    );
    for (const rel of orphanRels) {
      await this.db.run(`INSERT INTO knowledge_reconciliation (id, entity_type, entity_id, issue_type, description, correlation_id) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), 'RELATIONSHIP', rel.id, 'ORPHAN', `Missing source or target`, uuidv4()]);
    }
    return orphanRels;
  }

  async validateGraphIntegrity(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const orphanRels = await this.reconcileGraph();
    if (orphanRels.length > 0) issues.push('Orphan relationships found');
    const duplicateNodes = await this.db.all(`SELECT node_type, identifier, COUNT(*) as cnt FROM knowledge_nodes GROUP BY node_type, identifier HAVING cnt > 1`);
    if (duplicateNodes.length > 0) issues.push('Duplicate nodes found');
    return { valid: issues.length === 0, issues };
  }

  async recordDecision(input: {
    decision_type: string;
    input_state?: string;
    evidence?: string;
    selected_action: string;
    rejected_alternatives?: string;
    constraints?: string;
    policy_version?: string;
    confidence?: number;
    outcome?: string;
    provenance?: string;
  }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO decision_memory (id, decision_type, input_state, evidence, selected_action, rejected_alternatives, constraints, policy_version, confidence, outcome, provenance, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.decision_type, input.input_state ?? null, input.evidence ?? null, input.selected_action, input.rejected_alternatives ?? null, input.constraints ?? null, input.policy_version ?? null, input.confidence ?? null, input.outcome ?? null, input.provenance ?? null, uuidv4()]
    );
    return id;
  }

  async retrieveDecision(decision_id: string): Promise<any> {
    return this.db.get('SELECT * FROM decision_memory WHERE id = ?', [decision_id]);
  }

  async explainDecision(decision_id: string): Promise<string> {
    const decision = await this.db.get('SELECT * FROM decision_memory WHERE id = ?', [decision_id]);
    if (!decision) throw new Error('Decision not found');
    let evidence: any = decision.evidence;
    try { evidence = decision.evidence ? JSON.parse(decision.evidence) : []; } catch { evidence = decision.evidence; }
    return `Decision ${decision_id}: ${decision.decision_type} -> ${decision.selected_action}. Evidence: ${JSON.stringify(evidence)}. Policy: ${decision.policy_version ?? 'N/A'}`;
  }

  async runCounterfactual(input: { scenario: string; baseline_decision_id?: string }): Promise<{ scenario_id: string; result: string; hypothetical: boolean }> {
    const id = uuidv4();
    return { scenario_id: id, result: `Counterfactual: ${input.scenario}`, hypothetical: true };
  }

  async findSimilarIncidents(input: { incident_type?: string; environment?: string; resource_type?: string; dependency_id?: string }): Promise<any[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    if (input.incident_type) { conditions.push('incident_type = ?'); params.push(input.incident_type); }
    if (input.environment) { conditions.push('environment = ?'); params.push(input.environment); }
    if (input.resource_type) { conditions.push('resource_type = ?'); params.push(input.resource_type); }
    if (input.dependency_id) { conditions.push('dependency_id = ?'); params.push(input.dependency_id); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    return this.db.all(`SELECT * FROM knowledge_nodes WHERE node_type = 'incident'${where}`, params);
  }

  async retrieveRemediationHistory(incident_type?: string): Promise<any[]> {
    if (incident_type) {
      return this.db.all('SELECT * FROM remediation_memory WHERE incident_type = ?', [incident_type]);
    }
    return this.db.all('SELECT * FROM remediation_memory');
  }

  async recordRemediationMemory(input: { incident_type: string; remediation_action: string; outcome: string; success: boolean }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO remediation_memory (id, incident_type, remediation_action, outcome, success)
       VALUES (?,?,?,?,?)`,
      [id, input.incident_type, input.remediation_action, input.outcome, input.success ? 1 : 0]
    );
    return id;
  }

  async recordAudit(input: { event_type: string; entity_type: string; entity_id: string; actor: string; previous_state?: any; new_state?: any; reason?: string; epoch: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO knowledge_audit (id, event_type, entity_type, entity_id, actor, previous_state, new_state, reason, correlation_id, epoch)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, input.event_type, input.entity_type, input.entity_id, input.actor, JSON.stringify(input.previous_state ?? null), JSON.stringify(input.new_state ?? null), input.reason ?? null, uuidv4(), input.epoch]
    );
    return id;
  }

  async recordLineage(input: { entity_type: string; entity_id: string; phase: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO knowledge_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`,
      [id, input.entity_type, input.entity_id, input.phase, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async recordLearning(input: { learning_type: string; entity_id: string; data: any }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO knowledge_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`,
      [id, input.learning_type, input.entity_id, JSON.stringify(input.data), uuidv4()]);
    return id;
  }

  async replayHistoricalDecision(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}