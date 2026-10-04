// src/core/security-persistence-repository.ts
//
// Phase 246: authoritative PostgreSQL persistence for the security control plane.
//
// AsyncNexusEngine exposes parameterized SQL (prepareAsync/run/get/all), not the
// legacy NexusEngine KV API. This repository is the sole bridge between the
// security domain types (src/core/types.ts) and the security_* tables created by
// pg-bootstrap.ts. Every statement is parameterized. No silent fallback to SQLite.

import { PgAsyncEngine } from "./pg-async-engine";
import {
  SecurityExecution,
  SecurityExecutionStatus,
  SecurityEvidence,
  SecurityFinding,
  FindingStatus,
  RiskAssessment,
  SecurityDecision,
  SecurityFindingObservation,
  FindingSeverity,
} from "./types";

function jsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function jsonOrUndef<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  try { return typeof v === "string" ? (JSON.parse(v) as T) : (v as T); }
  catch { return undefined; }
}

export class SecurityPersistenceRepository {
  constructor(private db: PgAsyncEngine) {}

  // ---------------- security_executions ----------------
  async insertExecution(e: SecurityExecution): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_executions " +
      "(id, project_id, execution_id, commit_sha, artifact_digest, release_id, " +
      " status, started_at, completed_at, verdict) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      e.id, e.project_id, e.execution_id,
      e.commit_sha ?? null, e.artifact_digest ?? null, e.release_id ?? null,
      e.status, e.started_at, e.completed_at ?? null, e.verdict ?? null,
    );
  }

  async getExecution(id: string): Promise<SecurityExecution | undefined> {
    const row = await this.db.prepareAsync(
      "SELECT * FROM security_executions WHERE id = ?",
    ).get<any>(id);
    return row ? this.mapExecution(row) : undefined;
  }

  async updateExecutionStatus(
    id: string,
    status: SecurityExecutionStatus,
    verdict: "PASS" | "FAIL" | "BLOCKED" | null,
    completedAt: string | null,
  ): Promise<boolean> {
    const r = await this.db.prepareAsync(
      "UPDATE security_executions SET status = ?, verdict = ?, completed_at = ? WHERE id = ?",
    ).run(status, verdict, completedAt, id);
    return (r.changes ?? 0) === 1;
  }

  async listExecutionsByExecution(executionId: string): Promise<SecurityExecution[]> {
    const rows = await this.db.prepareAsync(
      "SELECT * FROM security_executions WHERE execution_id = ? ORDER BY started_at ASC",
    ).all<any>(executionId);
    return rows.map((r) => this.mapExecution(r));
  }

  // ---------------- security_evidence ----------------
  async insertEvidence(e: SecurityEvidence): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_evidence " +
      "(id, project_id, execution_id, release_id, commit_sha, artifact_id, " +
      " artifact_digest, environment, scanner, category, status, started_at, " +
      " completed_at, duration_ms, raw_reference, normalized_reference, sha256, " +
      " expires_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      e.id, e.project_id, e.execution_id, e.release_id ?? null,
      e.commit_sha ?? null, e.artifact_id ?? null, e.artifact_digest ?? null,
      e.environment ?? null, e.scanner, e.category, e.status,
      e.started_at ?? null, e.completed_at ?? null, e.duration_ms ?? null,
      e.raw_reference ?? null, e.normalized_reference ?? null,
      e.sha256 ?? null, e.expires_at ?? null, e.created_at,
    );
  }

  async listEvidenceByExecution(executionId: string): Promise<SecurityEvidence[]> {
    const rows = await this.db.prepareAsync(
      "SELECT * FROM security_evidence WHERE execution_id = ? ORDER BY created_at ASC",
    ).all<any>(executionId);
    return rows.map((r) => this.mapEvidence(r));
  }

  async getEvidenceById(id: string): Promise<SecurityEvidence | undefined> {
    const row = await this.db.prepareAsync(
      "SELECT * FROM security_evidence WHERE id = ?",
    ).get<any>(id);
    return row ? this.mapEvidence(row) : undefined;
  }

  // ---------------- security_findings ----------------
  async insertFinding(f: SecurityFinding): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_findings " +
      "(finding_id, evidence_id, project_id, execution_id, release_id, " +
      " artifact_digest, scanner, category, severity, title, description, " +
      " fingerprint, file, line, column_number, \"package\", dependency, version, " +
      " fixed_version, cve, cwe, resource, status, created_at, expires_at, " +
      " approved_by, approved_at, scope, false_positive_evidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      f.finding_id, f.evidence_id, f.project_id, f.execution_id,
      f.release_id ?? null, f.artifact_digest ?? null, f.scanner, f.category,
      f.severity, f.title, f.description ?? null, f.fingerprint,
      f.file ?? null, f.line ?? null, (f as any).column ?? null, (f as any).package ?? null,
      f.dependency ?? null, f.version ?? null, f.fixed_version ?? null,
      f.cve ?? null, f.cwe ?? null, f.resource ?? null,
      f.status ?? "OPEN", (f as any).created_at ?? new Date().toISOString(),
      (f as any).expires_at ?? null, (f as any).approved_by ?? null,
      (f as any).approved_at ?? null, (f as any).scope ?? null,
      (f as any).false_positive_evidence ?? null,
    );
  }

  async listFindingsByExecution(executionId: string): Promise<SecurityFinding[]> {
    const rows = await this.db.prepareAsync(
      "SELECT * FROM security_findings WHERE execution_id = ? ORDER BY created_at ASC",
    ).all<any>(executionId);
    return rows.map((r) => this.mapFinding(r));
  }

  async getFindingById(findingId: string): Promise<SecurityFinding | undefined> {
    const row = await this.db.prepareAsync(
      "SELECT * FROM security_findings WHERE finding_id = ?",
    ).get<any>(findingId);
    return row ? this.mapFinding(row) : undefined;
  }

  async getFindingByFingerprint(fingerprint: string): Promise<SecurityFinding | undefined> {
    const row = await this.db.prepareAsync(
      "SELECT * FROM security_findings WHERE fingerprint = ? LIMIT 1",
    ).get<any>(fingerprint);
    return row ? this.mapFinding(row) : undefined;
  }

  async updateFindingStatus(findingId: string, status: FindingStatus): Promise<boolean> {
    const r = await this.db.prepareAsync(
      "UPDATE security_findings SET status = ? WHERE finding_id = ?",
    ).run(status, findingId);
    return (r.changes ?? 0) === 1;
  }

  // ---------------- security_finding_observations ----------------
  async insertObservation(o: SecurityFindingObservation): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_finding_observations " +
      "(id, finding_id, execution_id, observed_at, severity, raw_data) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      o.id, o.finding_id, o.execution_id, o.observed_at,
      o.severity, o.raw_data ?? null,
    );
  }

  // ---------------- security_risk_assessments ----------------
  async insertRiskAssessment(a: RiskAssessment): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_risk_assessments " +
      "(id, project_id, execution_id, release_id, artifact_digest, " +
      " severity_counts, correlated_findings, risk_score, explanation, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      a.id, a.project_id, a.execution_id, a.release_id ?? null,
      a.artifact_digest ?? null,
      jsonOrNull(a.severity_counts), a.correlated_findings ?? 0,
      a.risk_score, jsonOrNull(a.explanation), a.created_at,
    );
  }

  async listRiskAssessmentsByExecution(executionId: string): Promise<RiskAssessment[]> {
    const rows = await this.db.prepareAsync(
      "SELECT * FROM security_risk_assessments WHERE execution_id = ? ORDER BY created_at ASC",
    ).all<any>(executionId);
    return rows.map((r) => this.mapRisk(r));
  }

  // ---------------- security_decisions ----------------
  async insertDecision(d: SecurityDecision): Promise<void> {
    await this.db.prepareAsync(
      "INSERT INTO security_decisions " +
      "(id, project_id, execution_id, release_id, artifact_digest, " +
      " policy_id, policy_version, verdict, canonical_decision, reasons, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      d.id, d.project_id, d.execution_id, d.release_id ?? null,
      d.artifact_digest ?? null, d.policy_id, d.policy_version,
      d.verdict, d.canonical_decision ?? null, jsonOrNull(d.reasons), d.created_at,
    );
  }

  async listDecisionsByExecution(executionId: string): Promise<SecurityDecision[]> {
    const rows = await this.db.prepareAsync(
      "SELECT * FROM security_decisions WHERE execution_id = ? ORDER BY created_at ASC",
    ).all<any>(executionId);
    return rows.map((r) => this.mapDecision(r));
  }

  // ---------------- mappers ----------------
  private mapExecution(r: any): SecurityExecution {
    return {
      id: r.id,
      project_id: r.project_id,
      execution_id: r.execution_id,
      commit_sha: r.commit_sha ?? "",
      artifact_digest: r.artifact_digest ?? undefined,
      release_id: r.release_id ?? undefined,
      status: r.status as SecurityExecutionStatus,
      started_at: r.started_at,
      completed_at: r.completed_at ?? undefined,
      verdict: r.verdict ?? undefined,
    };
  }

  private mapEvidence(r: any): SecurityEvidence {
    return {
      id: r.id,
      project_id: r.project_id,
      execution_id: r.execution_id,
      release_id: r.release_id ?? undefined,
      commit_sha: r.commit_sha ?? "",
      artifact_id: r.artifact_id ?? undefined,
      artifact_digest: r.artifact_digest ?? undefined,
      environment: r.environment ?? "",
      scanner: r.scanner,
      category: r.category,
      status: r.status,
      started_at: r.started_at ?? "",
      completed_at: r.completed_at ?? undefined,
      duration_ms: r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : undefined,
      raw_reference: r.raw_reference ?? undefined,
      normalized_reference: r.normalized_reference ?? undefined,
      sha256: r.sha256 ?? undefined,
      expires_at: r.expires_at ?? undefined,
      created_at: r.created_at,
    } as SecurityEvidence;
  }

  private mapFinding(r: any): SecurityFinding {
    return {
      finding_id: r.finding_id,
      evidence_id: r.evidence_id ?? "",
      project_id: r.project_id,
      execution_id: r.execution_id,
      release_id: r.release_id ?? undefined,
      artifact_digest: r.artifact_digest ?? undefined,
      scanner: r.scanner,
      category: r.category,
      severity: r.severity as FindingSeverity,
      title: r.title,
      description: r.description ?? undefined,
      fingerprint: r.fingerprint,
      file: r.file ?? undefined,
      line: r.line !== null && r.line !== undefined ? Number(r.line) : undefined,
      column: r.column_number !== null && r.column_number !== undefined ? Number(r.column_number) : undefined,
      package: r.package ?? undefined,
      dependency: r.dependency ?? undefined,
      version: r.version ?? undefined,
      fixed_version: r.fixed_version ?? undefined,
      cve: r.cve ?? undefined,
      cwe: r.cwe ?? undefined,
      resource: r.resource ?? undefined,
      status: r.status as FindingStatus,
      created_at: r.created_at,
      expires_at: r.expires_at ?? undefined,
      approved_by: r.approved_by ?? undefined,
      approved_at: r.approved_at ?? undefined,
      scope: r.scope ?? undefined,
      false_positive_evidence: r.false_positive_evidence ?? undefined,
    } as SecurityFinding;
  }

  private mapRisk(r: any): RiskAssessment {
    return {
      id: r.id,
      project_id: r.project_id,
      execution_id: r.execution_id,
      release_id: r.release_id ?? undefined,
      artifact_digest: r.artifact_digest ?? undefined,
      severity_counts: jsonOrUndef<Record<FindingSeverity, number>>(r.severity_counts) ?? {
        CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, UNKNOWN: 0,
      } as any,
      correlated_findings: r.correlated_findings !== null && r.correlated_findings !== undefined ? Number(r.correlated_findings) : 0,
      risk_score: typeof r.risk_score === "number" ? r.risk_score : Number(r.risk_score ?? 0),
      explanation: jsonOrUndef<string[]>(r.explanation) ?? [],
      created_at: r.created_at,
    };
  }

  private mapDecision(r: any): SecurityDecision {
    return {
      id: r.id,
      project_id: r.project_id,
      execution_id: r.execution_id,
      release_id: r.release_id ?? undefined,
      artifact_digest: r.artifact_digest ?? undefined,
      policy_id: r.policy_id,
      policy_version: r.policy_version,
      verdict: r.verdict,
      canonical_decision: r.canonical_decision ?? undefined,
      reasons: jsonOrUndef<string[]>(r.reasons) ?? [],
      created_at: r.created_at,
    };
  }
}