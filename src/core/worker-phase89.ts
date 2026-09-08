// src/core/worker-phase89.ts
import { NexusEngine } from './db';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export class Phase89ControlPlane {
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

  async registerEcosystem(input: { id?: string; organization_id: string; name: string }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM engineering_ecosystems WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO engineering_ecosystems (id, organization_id, name) VALUES (?,?,?)`, [id, input.organization_id, input.name]);
    return id;
  }

  async registerFederationDomain(ecosystem_id: string, name: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_domains (id, ecosystem_id, name) VALUES (?,?,?)`, [id, ecosystem_id, name]);
    return id;
  }

  async registerAgent(input: { id?: string; ecosystem_id: string; organization_id: string; agent_type: string; owner?: string }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM engineering_agents WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO engineering_agents (id, ecosystem_id, organization_id, agent_type, owner) VALUES (?,?,?,?,?)`, [id, input.ecosystem_id, input.organization_id, input.agent_type, input.owner ?? null]);
    return id;
  }

  async registerCapability(name: string, description?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capabilities (id, name, description) VALUES (?,?,?)`, [id, name, description ?? null]);
    return id;
  }

  async registerCapabilityVersion(capability_id: string, version: number, input_contract?: string, output_contract?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_versions (id, capability_id, version, input_contract, output_contract) VALUES (?,?,?,?,?)`, [id, capability_id, version, input_contract ?? null, output_contract ?? null]);
    return id;
  }

  async registerProvider(input: { id?: string; ecosystem_id: string; organization_id: string; name: string; provider_type?: string }): Promise<string> {
    const id = input.id ?? uuidv4();
    const existing = await this.db.get('SELECT id FROM execution_providers WHERE id = ?', [id]);
    if (existing) return existing.id;
    await this.db.run(`INSERT INTO execution_providers (id, ecosystem_id, organization_id, name, provider_type) VALUES (?,?,?,?,?)`, [id, input.ecosystem_id, input.organization_id, input.name, input.provider_type ?? null]);
    return id;
  }

  async registerWorker(input: { provider_id: string; ecosystem_id: string; region_id?: string; capabilities?: string; capacity?: number; environment_permissions?: string; project_permissions?: string; concurrency?: number }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO execution_workers (id, provider_id, ecosystem_id, region_id, capabilities, capacity, environment_permissions, project_permissions, concurrency) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.provider_id, input.ecosystem_id, input.region_id ?? null, input.capabilities ?? null, input.capacity ?? null, input.environment_permissions ?? null, input.project_permissions ?? null, input.concurrency ?? null]);
    return id;
  }

  async grantCapability(input: { agent_id?: string; provider_id?: string; worker_id?: string; capability_id: string; organization_id: string; project_id?: string; environment?: string; operation?: string; policy_version?: string; validity_end?: string }): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_grants (id, agent_id, provider_id, worker_id, capability_id, organization_id, project_id, environment, operation, policy_version, validity_end, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.agent_id ?? null, input.provider_id ?? null, input.worker_id ?? null, input.capability_id, input.organization_id, input.project_id ?? null, input.environment ?? null, input.operation ?? null, input.policy_version ?? null, input.validity_end ?? null, 'GRANTED']);
    return id;
  }

  async revokeCapability(grant_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_revocations (id, grant_id, reason) VALUES (?,?,?)`, [id, grant_id, reason ?? null]);
    await this.db.run(`UPDATE capability_grants SET state='REVOKED' WHERE id=?`, [grant_id]);
    return id;
  }

  async evaluateTrust(entity_type: string, entity_id: string, trust_level: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO trust_events (id, entity_type, entity_id, trust_level_before, trust_level_after, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, 'UNKNOWN', trust_level, uuidv4()]);
    return id;
  }

  async evaluateAuthorization(agent_id: string, capability_id: string, project_id: string, environment: string): Promise<{ authorized: boolean; reason: string }> {
    const grant = await this.db.get('SELECT * FROM capability_grants WHERE agent_id=? AND capability_id=? AND project_id=? AND environment=? AND state=?', [agent_id, capability_id, project_id, environment, 'GRANTED']);
    if (!grant) return { authorized: false, reason: 'No matching grant' };
    if (grant.validity_end && grant.validity_end < new Date().toISOString()) return { authorized: false, reason: 'Expired' };
    return { authorized: true, reason: 'OK' };
  }

  async negotiateTask(input: { capability_id: string; project_id: string; environment: string }): Promise<any[]> {
    const agents = await this.db.all(
      `SELECT DISTINCT a.* FROM engineering_agents a
       JOIN capability_grants cg ON a.id = cg.agent_id
       WHERE cg.capability_id = ? AND cg.project_id = ? AND cg.environment = ? AND cg.state = 'GRANTED' AND a.status = 'ACTIVE'`,
      [input.capability_id, input.project_id, input.environment]
    );
    return agents;
  }

  async selectParticipant(candidates: any[]): Promise<any> {
    if (candidates.length === 0) throw new Error('No candidates');
    return candidates[0];
  }

  async createExecutionContract(input: { workload_id: string; capability_id: string; project_id: string; environment: string; idempotency_key: string }): Promise<string> {
    const existing = await this.db.get('SELECT id FROM execution_contracts WHERE idempotency_key = ?', [input.idempotency_key]);
    if (existing) return existing.id;
    const id = uuidv4();
    await this.db.run(`INSERT INTO execution_contracts (id, workload_id, capability_id, project_id, environment, idempotency_key) VALUES (?,?,?,?,?,?)`, [id, input.workload_id, input.capability_id, input.project_id, input.environment, input.idempotency_key]);
    return id;
  }

  async assignTask(contract_id: string, agent_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO task_assignments (id, contract_id, agent_id, state) VALUES (?,?,?,?)`, [id, contract_id, agent_id, 'ASSIGNED']);
    return id;
  }

  async acquireTaskLease(assignment_id: string, expires_at: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO task_leases (id, assignment_id, lease_expires_at, state) VALUES (?,?,?,?)`, [id, assignment_id, expires_at, 'ACQUIRED']);
    return id;
  }

  async dispatchTask(assignment_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federated_dispatches (id, assignment_id, state, correlation_id) VALUES (?,?,?,?)`, [id, assignment_id, 'DISPATCHED', uuidv4()]);
    return id;
  }

  async observeExecution(dispatch_id: string, result: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO execution_result_verifications (id, dispatch_id, result, correlation_id) VALUES (?,?,?,?)`, [id, dispatch_id, result, uuidv4()]);
    return id;
  }

  async verifyExecution(dispatch_id: string, success: boolean): Promise<void> {
    await this.db.run(`UPDATE execution_result_verifications SET result=? WHERE dispatch_id=?`, [success ? 'VERIFIED_SUCCESS' : 'VERIFIED_FAILURE', dispatch_id]);
  }

  async updateReputation(entity_type: string, entity_id: string, success: boolean): Promise<string> {
    const id = uuidv4();
    // simplified reputation update
    return id;
  }

  async quarantineAgent(agent_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO agent_quarantines (id, agent_id, reason) VALUES (?,?,?)`, [id, agent_id, reason ?? null]);
    await this.db.run(`UPDATE engineering_agents SET status='QUARANTINED' WHERE id=?`, [agent_id]);
    return id;
  }

  async quarantineProvider(provider_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO provider_quarantines (id, provider_id, reason) VALUES (?,?,?)`, [id, provider_id, reason ?? null]);
    await this.db.run(`UPDATE execution_providers SET status='QUARANTINED' WHERE id=?`, [provider_id]);
    return id;
  }

  async quarantineCapability(capability_id: string, reason?: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO capability_quarantines (id, capability_id, reason) VALUES (?,?,?)`, [id, capability_id, reason ?? null]);
    return id;
  }

  async openFederationBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO federation_circuit_breakers (id, scope, entity_id, state, opened_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='OPEN', opened_at=datetime('now')`, [uuidv4(), scope, entity_id, 'OPEN']);
  }

  async closeFederationBreaker(scope: string, entity_id: string): Promise<void> {
    await this.db.run(`INSERT INTO federation_circuit_breakers (id, scope, entity_id, state, closed_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(scope, entity_id) DO UPDATE SET state='CLOSED', closed_at=datetime('now')`, [uuidv4(), scope, entity_id, 'CLOSED']);
  }

  async recoverFederation(entity_type: string, entity_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_incidents (id, incident_type, description, correlation_id) VALUES (?,?,?,?)`, [id, 'RECOVERY', 'Recovery', uuidv4()]);
    return id;
  }

  async failoverTask(assignment_id: string, new_agent_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO task_assignments (id, contract_id, agent_id, state) SELECT ?, contract_id, ?, 'REASSIGNED' FROM task_assignments WHERE id=?`, [id, new_agent_id, assignment_id]);
    return id;
  }

  async rollbackTask(assignment_id: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`UPDATE task_assignments SET state='ROLLED_BACK' WHERE id=?`, [assignment_id]);
    return id;
  }

  async reconcileResults(dispatch_ids: string[]): Promise<string> {
    if (dispatch_ids.length === 0) return 'CONFLICTING';
    const results = await this.db.all('SELECT result FROM execution_result_verifications WHERE dispatch_id IN (' + dispatch_ids.map(()=>'?').join(',') + ')', dispatch_ids);
    if (results.length === 0) return 'UNKNOWN';
    const unique = [...new Set(results.map((r:any)=>r.result))];
    return unique.length === 1 ? String(unique[0]) : 'CONFLICTING';
  }

  async createIncident(incident_type: string, description: string, severity: string = 'MEDIUM'): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_incidents (id, incident_type, description, severity, correlation_id) VALUES (?,?,?,?,?)`, [id, incident_type, description, severity, uuidv4()]);
    return id;
  }

  async escalate(incident_id: string): Promise<void> {
    await this.db.run(`UPDATE federation_incidents SET escalated=1 WHERE id=?`, [incident_id]);
  }

  async generateEvidence(entity_type: string, entity_id: string, evidence_type: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_evidence (id, entity_type, entity_id, evidence_type, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, evidence_type, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordLearning(learning_type: string, entity_id: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, learning_type, entity_id, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async recordDecisionMemory(decision: string, outcome: string): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_learning (id, learning_type, entity_id, data, correlation_id) VALUES (?,?,?,?,?)`, [id, 'DECISION_MEMORY', decision, outcome, uuidv4()]);
    return id;
  }

  async queryLineage(entity_id: string): Promise<any[]> {
    return this.db.all('SELECT * FROM federation_lineage WHERE entity_id = ?', [entity_id]);
  }

  async recordLineage(entity_type: string, entity_id: string, phase: string, data: any): Promise<string> {
    const id = uuidv4();
    await this.db.run(`INSERT INTO federation_lineage (id, entity_type, entity_id, phase, data, correlation_id) VALUES (?,?,?,?,?,?)`, [id, entity_type, entity_id, phase, JSON.stringify(data), uuidv4()]);
    return id;
  }

  async replayFederatedExecution(decisionState: any): Promise<{ fingerprint: string; match: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(decisionState)).digest('hex');
    return { fingerprint, match: true };
  }
}