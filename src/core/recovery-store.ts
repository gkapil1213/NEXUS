// src/core/recovery-store.ts
import Database from "better-sqlite3";
import { RecoveryPolicy, RecoveryJob } from "./recovery-models";

export class RecoveryStore {
  constructor(private db: Database.Database) {}

  // Policies
  getPolicy(id: string): RecoveryPolicy | undefined {
    const row = this.db.prepare("SELECT * FROM recovery_policies WHERE id = ?").get(id);
    return row ? this.mapPolicy(row) : undefined;
  }

  listPolicies(): RecoveryPolicy[] {
    return this.db.prepare("SELECT * FROM recovery_policies ORDER BY created_at DESC")
      .all()
      .map(this.mapPolicy);
  }

  addPolicy(policy: RecoveryPolicy): void {
    this.db.prepare(`
      INSERT INTO recovery_policies (id, name, target_type, conditions, actions, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policy.id,
      policy.name,
      policy.targetType,
      JSON.stringify(policy.conditions),
      JSON.stringify(policy.actions),
      policy.enabled ? 1 : 0,
      policy.createdAt,
      policy.updatedAt
    );
  }

  updatePolicy(policy: RecoveryPolicy): void {
    this.db.prepare(`
      UPDATE recovery_policies
      SET name = ?, target_type = ?, conditions = ?, actions = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      policy.name,
      policy.targetType,
      JSON.stringify(policy.conditions),
      JSON.stringify(policy.actions),
      policy.enabled ? 1 : 0,
      policy.updatedAt,
      policy.id
    );
  }

  // Jobs
  getJob(id: string): RecoveryJob | undefined {
    const row = this.db.prepare("SELECT * FROM recovery_jobs WHERE id = ?").get(id);
    return row ? this.mapJob(row) : undefined;
  }

  listJobs(policyId?: string): RecoveryJob[] {
    const sql = policyId
      ? "SELECT * FROM recovery_jobs WHERE policy_id = ? ORDER BY started_at DESC"
      : "SELECT * FROM recovery_jobs ORDER BY started_at DESC";
    const stmt = this.db.prepare(sql);
    const rows = policyId ? stmt.all(policyId) : stmt.all();
    return rows.map(this.mapJob);
  }

  addJob(job: RecoveryJob): void {
    this.db.prepare(`
      INSERT INTO recovery_jobs (id, policy_id, status, started_at, completed_at, error, result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.policyId,
      job.status,
      job.startedAt,
      job.completedAt,
      job.error,
      job.result ? JSON.stringify(job.result) : null
    );
  }

  updateJob(job: RecoveryJob): void {
    this.db.prepare(`
      UPDATE recovery_jobs
      SET status = ?, started_at = ?, completed_at = ?, error = ?, result = ?
      WHERE id = ?
    `).run(
      job.status,
      job.startedAt,
      job.completedAt,
      job.error,
      job.result ? JSON.stringify(job.result) : null,
      job.id
    );
  }

  private mapPolicy(row: any): RecoveryPolicy {
    return {
      id: row.id,
      name: row.name,
      targetType: row.target_type,
      conditions: JSON.parse(row.conditions),
      actions: JSON.parse(row.actions),
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapJob(row: any): RecoveryJob {
    return {
      id: row.id,
      policyId: row.policy_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }
}
// Add import for RecoveryAttemptRecord if needed

export class RecoveryStore {
  // existing methods...

  // ---------- Recovery Attempts ----------
  addAttempt(attempt: RecoveryAttemptRecord): void {
    this.db.prepare(`
      INSERT INTO recovery_attempts (
        id, incident_id, attempt_number, action_json, decision,
        status, verification_result, evidence_json, error,
        started_at, completed_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.incidentId,
      attempt.attemptNumber,
      JSON.stringify(attempt.action),
      attempt.decision,
      attempt.status,
      attempt.verificationResult === undefined ? null : attempt.verificationResult,
      JSON.stringify(attempt.evidence),
      attempt.error || null,
      attempt.startedAt,
      attempt.completedAt || null,
      attempt.idempotencyKey
    );
  }

  updateAttempt(attempt: RecoveryAttemptRecord): void {
    this.db.prepare(`
      UPDATE recovery_attempts SET
        status = ?,
        verification_result = ?,
        evidence_json = ?,
        error = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      attempt.status,
      attempt.verificationResult === undefined ? null : attempt.verificationResult,
      JSON.stringify(attempt.evidence),
      attempt.error || null,
      attempt.completedAt || null,
      attempt.id
    );
  }

  getAttemptByIdempotencyKey(key: string): RecoveryAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM recovery_attempts WHERE idempotency_key = ?
    `).get(key);
    return row ? this.mapAttempt(row) : undefined;
  }

  getAttempt(id: string): RecoveryAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM recovery_attempts WHERE id = ?").get(id);
    return row ? this.mapAttempt(row) : undefined;
  }

  listAttemptsForIncident(incidentId: string): RecoveryAttemptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM recovery_attempts WHERE incident_id = ? ORDER BY attempt_number ASC
    `).all(incidentId);
    return rows.map(this.mapAttempt);
  }

  private mapAttempt(row: any): RecoveryAttemptRecord {
    return {
      id: row.id,
      incidentId: row.incident_id,
      attemptNumber: row.attempt_number,
      action: JSON.parse(row.action_json),
      decision: row.decision,
      status: row.status,
      verificationResult: row.verification_result === null ? undefined : !!row.verification_result,
      evidence: JSON.parse(row.evidence_json),
      error: row.error || undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      idempotencyKey: row.idempotency_key,
    };
  }
}