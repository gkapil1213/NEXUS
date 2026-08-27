import { NexusEngine, nid } from "./db";
import {
  SecurityEvidence,
  SecurityFinding,
  FindingStatus,
  SecurityDecision,
  RiskAssessment,
  SecurityExecution,
  FindingSeverity,
} from "./types";
import { fingerprintFinding } from "./security-normalizer";
import { EventService } from "./events";
import { AuditService } from "./audit";

/**
 * SecurityExecutionService
 * Manages the lifecycle of a security execution.
 */
export class SecurityExecutionService {
  private events: EventService;
  private audit: AuditService;

  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
    this.audit = new AuditService(engine);
  }

  async start(
    projectId: string,
    executionId: string,
    commitSha: string,
    artifactDigest?: string,
    releaseId?: string
  ): Promise<SecurityExecution> {
    const now = new Date().toISOString();
    const record: SecurityExecution = {
      id: nid("secexec"),
      project_id: projectId,
      execution_id: executionId,
      commit_sha: commitSha,
      artifact_digest: artifactDigest,
      release_id: releaseId,
      status: "QUEUED",
      started_at: now,
    };
    await this.engine.put("security_executions", record.id, record);
    await this.events.emit({
      type: "security.execution.started",
      execution_id: executionId,
      project_id: projectId,
    } as any);
    return record;
  }

  async markRunning(id: string): Promise<void> {
    const existing = await this.engine.get<SecurityExecution>("security_executions", id);
    if (!existing) throw new Error("SecurityExecution not found");
    if (existing.status !== "QUEUED") {
      throw new Error(`Illegal transition from ${existing.status} to RUNNING`);
    }
    const updated: SecurityExecution = { ...existing, status: "RUNNING" };
    await this.engine.put("security_executions", id, updated);
  }

  async complete(
    id: string,
    verdict: "PASS" | "FAIL" | "BLOCKED",
    status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED"
  ): Promise<SecurityExecution> {
    const existing = await this.engine.get<SecurityExecution>("security_executions", id);
    if (!existing) throw new Error("SecurityExecution not found");
    const allowedFrom = new Set(["RUNNING", "QUEUED"]);
    if (!allowedFrom.has(existing.status)) {
      throw new Error(`Illegal transition from ${existing.status} to ${status}`);
    }
    const updated: SecurityExecution = {
      ...existing,
      status,
      verdict,
      completed_at: new Date().toISOString(),
    };
    await this.engine.put("security_executions", id, updated);
    await this.events.emit({
      type: `security.execution.${status.toLowerCase()}`,
      execution_id: existing.execution_id,
      project_id: existing.project_id,
    } as any);
    return updated;
  }
}

/**
 * SecurityEvidenceService
 * Persists normalized security evidence with immutability and idempotency.
 */
export class SecurityEvidenceService {
  private events: EventService;

  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
  }

  async persistEvidence(
    evidence: Omit<SecurityEvidence, "id" | "created_at">
  ): Promise<SecurityEvidence> {
    const existing = await this.getByExecutionAndScanner(
      evidence.execution_id,
      evidence.scanner,
      evidence.category
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: SecurityEvidence = {
      ...evidence,
      id: nid("secevid"),
      created_at: now,
    };
    await this.engine.put("security_evidence", record.id, record);
    await this.events.emit({
      type: "security.evidence.created",
      execution_id: evidence.execution_id,
      project_id: evidence.project_id,
      evidence_id: record.id,
    } as any);
    return record;
  }

  async getById(id: string): Promise<SecurityEvidence | undefined> {
    return this.engine.get<SecurityEvidence>("security_evidence", id);
  }

  async getByExecution(executionId: string): Promise<SecurityEvidence[]> {
    const all = await this.engine.all<SecurityEvidence>("security_evidence");
    return all.filter((e) => e.execution_id === executionId);
  }

  private async getByExecutionAndScanner(
    executionId: string,
    scanner: string,
    category: string
  ): Promise<SecurityEvidence | undefined> {
    const all = await this.getByExecution(executionId);
    return all.find((e) => e.scanner === scanner && e.category === category);
  }
}

/**
 * SecurityFindingService
 * Handles finding ingestion, deduplication via fingerprints, lifecycle transitions,
 * false positive/accepted risk metadata, and expiry reversion.
 */
export class SecurityFindingService {
  private events: EventService;
  private audit: AuditService;

  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
    this.audit = new AuditService(engine);
  }

  async ingestFindings(
    evidence: SecurityEvidence,
    rawFindings: Partial<SecurityFinding>[]
  ): Promise<SecurityFinding[]> {
    const result: SecurityFinding[] = [];
    for (const raw of rawFindings) {
      const fingerprint = fingerprintFinding({
        scanner: evidence.scanner,
        category: evidence.category,
        title: raw.title || "Unknown finding",
        file: raw.file,
        line: raw.line,
        cve: raw.cve,
        package: raw.package,
        resource: raw.resource,
      });

      const existing = await this.getByFingerprint(fingerprint);

      if (existing) {
        if (existing.status === "RESOLVED") {
          await this.transition(existing.finding_id, "REOPENED", "system", "Fingerprint reappeared after resolution");
        } else {
          const updated: SecurityFinding = {
            ...existing,
            last_seen: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            evidence_id: evidence.id,
            execution_id: evidence.execution_id,
            project_id: evidence.project_id,
            severity: raw.severity || existing.severity,
            description: raw.description ?? existing.description,
            fixed_version: raw.fixed_version ?? existing.fixed_version,
          };
          await this.engine.put("security_findings", existing.finding_id, updated);
          await this.events.emit({ type: "security.finding.updated", finding_id: existing.finding_id } as any);
          result.push(updated);
        }
        continue;
      }

      const now = new Date().toISOString();
      const finding: SecurityFinding = {
        finding_id: nid("secfind"),
        evidence_id: evidence.id,
        project_id: evidence.project_id,
        execution_id: evidence.execution_id,
        release_id: evidence.release_id,
        artifact_digest: evidence.artifact_digest,
        scanner: evidence.scanner,
        category: evidence.category,
        severity: raw.severity || "UNKNOWN",
        title: raw.title || "Unknown finding",
        description: raw.description,
        fingerprint,
        file: raw.file,
        line: raw.line,
        column: raw.column,
        package: raw.package,
        dependency: raw.dependency,
        version: raw.version,
        fixed_version: raw.fixed_version,
        cve: raw.cve,
        cwe: raw.cwe,
        resource: raw.resource,
        location: raw.location,
        target: raw.target,
        evidence_reference: raw.evidence_reference,
        first_seen: now,
        last_seen: now,
        status: "NEW",
        created_at: now,
        updated_at: now,
      };
      await this.engine.put("security_findings", finding.finding_id, finding);
      await this.events.emit({ type: "security.finding.created", finding_id: finding.finding_id, fingerprint } as any);
      result.push(finding);
    }
    return result;
  }

  async transition(
    findingId: string,
    newStatus: FindingStatus,
    actor: string,
    reason?: string,
    metadata?: {
      false_positive_evidence?: string;
      approved_by?: string;
      approved_at?: string;
      expires_at?: string;
      scope?: string;
    }
  ): Promise<SecurityFinding> {
    const existing = await this.engine.get<SecurityFinding>("security_findings", findingId);
    if (!existing) throw new Error("Finding not found");

    const legalTransitions: Record<FindingStatus, FindingStatus[]> = {
      NEW: ["CONFIRMED", "FALSE_POSITIVE", "ACCEPTED_RISK"],
      CONFIRMED: ["RESOLVED", "FALSE_POSITIVE", "ACCEPTED_RISK"],
      REOPENED: ["CONFIRMED", "FALSE_POSITIVE", "ACCEPTED_RISK"],
      RESOLVED: ["REOPENED"],
      FALSE_POSITIVE: ["NEW"],
      ACCEPTED_RISK: ["NEW"],
    };

    if (!legalTransitions[existing.status]?.includes(newStatus)) {
      throw new Error(`Illegal transition from ${existing.status} to ${newStatus}`);
    }

    if (newStatus === "FALSE_POSITIVE") {
      if (!reason || !metadata?.false_positive_evidence) {
        throw new Error("False positive requires reason and evidence");
      }
    }
    if (newStatus === "ACCEPTED_RISK") {
      if (!reason || !metadata?.approved_by || !metadata?.expires_at) {
        throw new Error("Accepted risk requires reason, approver, and expiry");
      }
    }

    const now = new Date().toISOString();
    const updated: SecurityFinding = { ...existing, status: newStatus, updated_at: now };

    if (newStatus === "FALSE_POSITIVE") {
      updated.false_positive_reason = reason;
      updated.false_positive_actor = actor;
      updated.false_positive_at = now;
      updated.false_positive_evidence = metadata?.false_positive_evidence;
    }

    if (newStatus === "ACCEPTED_RISK") {
      updated.accepted_risk_reason = reason;
      updated.approved_by = metadata?.approved_by;
      updated.approved_at = now;
      updated.expires_at = metadata?.expires_at;
      updated.scope = metadata?.scope;
    }

    await this.engine.put("security_findings", findingId, updated);

    await this.audit.record({
      actor,
      action: `finding.${newStatus.toLowerCase().replace(/_/g, "_")}`,
      resource: "security_finding",
      resource_id: findingId,
      reason: reason || "No reason provided",
      metadata: { from_status: existing.status, to_status: newStatus },
    } as any);

    await this.events.emit({
      type: `security.finding.${newStatus.toLowerCase().replace(/_/g, "_")}`,
      finding_id: findingId,
      fingerprint: existing.fingerprint,
    } as any);

    return updated;
  }

  async revertExpiredAcceptedRisks(): Promise<void> {
    const all = await this.engine.all<SecurityFinding>("security_findings");
    const now = new Date().toISOString();
    for (const f of all) {
      if (f.status === "ACCEPTED_RISK" && f.expires_at && f.expires_at < now) {
        await this.transition(f.finding_id, "NEW", "system", "Accepted risk expired");
      }
    }
  }

  async getByFingerprint(fingerprint: string): Promise<SecurityFinding | undefined> {
    const all = await this.engine.all<SecurityFinding>("security_findings");
    return all.find((f) => f.fingerprint === fingerprint);
  }

  async getByExecution(executionId: string): Promise<SecurityFinding[]> {
    const all = await this.engine.all<SecurityFinding>("security_findings");
    return all.filter((f) => f.execution_id === executionId);
  }

  async getById(findingId: string): Promise<SecurityFinding | undefined> {
    return this.engine.get<SecurityFinding>("security_findings", findingId);
  }
}

/**
 * RiskCorrelationService
 * Correlates findings and computes a deterministic risk assessment.
 */
export class RiskCorrelationService {
  private events: EventService;

  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
  }

  async assess(executionId: string): Promise<RiskAssessment> {
    const allFindings = await this.engine.all<SecurityFinding>("security_findings");
    const findings = allFindings.filter((f) => f.execution_id === executionId);

    const uniqueFindings = new Map<string, SecurityFinding>();
    findings.forEach((f) => uniqueFindings.set(f.fingerprint, f));

    const severityCounts: Record<FindingSeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
      UNKNOWN: 0,
    };
    uniqueFindings.forEach((f) => {
      severityCounts[f.severity]++;
    });

    const weights: Record<FindingSeverity, number> = {
      CRITICAL: 40,
      HIGH: 20,
      MEDIUM: 8,
      LOW: 3,
      INFO: 1,
      UNKNOWN: 5,
    };
    const score = Object.entries(severityCounts).reduce(
      (sum, [sev, count]) => sum + weights[sev as FindingSeverity] * count,
      0
    );

    const explanation = [
      `Total unique findings: ${uniqueFindings.size}`,
      `Severity distribution: ${JSON.stringify(severityCounts)}`,
      `Risk score = sum(severity_weight * count) = ${score}`,
    ];

    const assessment: RiskAssessment = {
      id: nid("secrisk"),
      project_id: findings[0]?.project_id || "",
      execution_id: executionId,
      release_id: findings[0]?.release_id,
      artifact_digest: findings[0]?.artifact_digest,
      severity_counts: severityCounts,
      correlated_findings: uniqueFindings.size,
      risk_score: score,
      explanation,
      created_at: new Date().toISOString(),
    };

    await this.engine.put("security_risk_assessments", assessment.id, assessment);
    await this.events.emit({ type: "security.risk.assessed", execution_id: executionId, risk_assessment_id: assessment.id } as any);
    return assessment;
  }
}

/**
 * SecurityDecisionService
 * Persists immutable security decisions.
 */
export class SecurityDecisionService {
  private events: EventService;
  private audit: AuditService;

  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
    this.audit = new AuditService(engine);
  }

  async recordDecision(
    decision: Omit<SecurityDecision, "id" | "created_at">
  ): Promise<SecurityDecision> {
    const record: SecurityDecision = {
      ...decision,
      id: nid("secdec"),
      created_at: new Date().toISOString(),
    };
    await this.engine.put("security_decisions", record.id, record);
    await this.events.emit({ type: "security.decision.created", decision_id: record.id, execution_id: decision.execution_id } as any);
    return record;
  }

  async getByExecution(executionId: string): Promise<SecurityDecision[]> {
    const all = await this.engine.all<SecurityDecision>("security_decisions");
    return all.filter((d) => d.execution_id === executionId);
  }
}