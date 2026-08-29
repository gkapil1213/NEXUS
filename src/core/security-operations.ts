import { NexusEngine, nid } from "./db";
import { EventService } from "./events";
import { AuditService } from "./audit";
import {
  SecurityEvidence,
  SecurityFinding,
  SecurityExecution,
  RiskAssessment,
  SecurityScannerHealth,
  ScannerHealthStatus,
  SecurityPolicyEvaluationRecord,
  SecurityRiskSnapshot,
  SecurityDriftEvent,
} from "./types";
import { SecurityEvidenceService } from "./security-services";

export class SecurityPostureService {
  constructor(private engine: NexusEngine) {}

  async getProjectPosture(projectId: string): Promise<any> {
    const findings = await this.engine.all<SecurityFinding>("security_findings");
    const projectFindings = findings.filter((f) => f.project_id === projectId);

    const openFindings = projectFindings.filter((f) =>
      ["NEW", "CONFIRMED", "REOPENED", "OPEN", "ACKNOWLEDGED", "IN_PROGRESS"].includes(f.status)
    );

    const critical = openFindings.filter((f) => f.severity === "CRITICAL").length;
    const high = openFindings.filter((f) => f.severity === "HIGH").length;
    const medium = openFindings.filter((f) => f.severity === "MEDIUM").length;
    const low = openFindings.filter((f) => f.severity === "LOW").length;
    const unknown = openFindings.filter((f) => f.severity === "UNKNOWN" || f.severity === "INFO").length;

    const evidenceList = await this.engine.all<SecurityEvidence>("security_evidence");
    const projectEvidence = evidenceList.filter((e) => e.project_id === projectId);

    const scannerHealth = await this.engine.all<SecurityScannerHealth>("security_scanner_health");
    const requiredScanners = ["semgrep", "gitleaks", "trivy", "checkov"];
    const unavailableRequired = requiredScanners.filter(
      (s) => !scannerHealth.find((h) => h.scanner === s && h.available)
    );

    let status: string;
    if (unavailableRequired.length > 0) {
      status = "BLOCKED";
    } else if (critical > 0 || high > 0) {
      status = "CRITICAL";
    } else if (medium > 0 || low > 0 || unknown > 0) {
      status = "AT_RISK";
    } else if (projectEvidence.length === 0) {
      status = "UNKNOWN";
    } else {
      const latestEvidence = projectEvidence.reduce<SecurityEvidence | undefined>((max, e) => {
        const maxTime = max?.completed_at ?? "";
        const eTime = e.completed_at ?? "";
        return eTime > maxTime ? e : max;
      }, undefined);
      const stale = latestEvidence && latestEvidence.completed_at
        ? Date.now() - new Date(latestEvidence.completed_at).getTime() > 86400000
        : true;
      status = stale ? "STALE" : "HEALTHY";
    }

    const riskScore = critical * 40 + high * 20 + medium * 8 + low * 3 + unknown * 5;

    const lastScan = projectEvidence.length
      ? projectEvidence.reduce<SecurityEvidence | undefined>((max, e) => {
          const maxTime = max?.completed_at ?? "";
          const eTime = e.completed_at ?? "";
          return eTime > maxTime ? e : max;
        }, undefined)?.completed_at ?? null
      : null;

    return {
      project_id: projectId,
      status,
      risk_score: riskScore,
      critical,
      high,
      medium,
      low,
      unknown,
      open_findings: openFindings.length,
      verified_artifacts: projectEvidence.filter((e) => e.status === "PASS").length,
      last_scan: lastScan,
      last_release: null,
      last_verified_deployment: null,
    };
  }
}

export class ScannerHealthService {
  private events: EventService;
  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
  }

  async updateHealth(
    scanner: string,
    data: Partial<SecurityScannerHealth> & { health: ScannerHealthStatus; available: boolean }
  ): Promise<SecurityScannerHealth> {
    const existing = await this.getScannerHealth(scanner);
    const now = new Date().toISOString();
    const record: SecurityScannerHealth = {
      id: existing?.id ?? nid("scanhealth"),
      scanner,
      version: data.version,
      available: data.available,
      last_execution: data.last_execution,
      last_success: data.last_success,
      last_failure: data.last_failure,
      duration_ms: data.duration_ms,
      timeout_count: data.timeout_count ?? existing?.timeout_count ?? 0,
      failure_count: data.failure_count ?? existing?.failure_count ?? 0,
      findings_count: data.findings_count ?? existing?.findings_count ?? 0,
      health: data.health,
      updated_at: now,
    };
    await this.engine.put("security_scanner_health", record.id, record);
    await this.events.emit({
      type: "security.scanner.health",
      scanner,
      health: data.health,
    } as any);
    return record;
  }

  async getScannerHealth(scanner: string): Promise<SecurityScannerHealth | undefined> {
    const all = await this.engine.all<SecurityScannerHealth>("security_scanner_health");
    return all.find((h) => h.scanner === scanner);
  }

  async listHealth(): Promise<SecurityScannerHealth[]> {
    return this.engine.all<SecurityScannerHealth>("security_scanner_health");
  }
}

export class SecurityEvidenceIntegrityService {
  constructor(private engine: NexusEngine) {}

  async computeSha256(content: string): Promise<string> {
    const { sha256Hex } = await import("./db");
    return sha256Hex(content);
  }

  async recordEvidenceWithHash(
    evidence: Omit<SecurityEvidence, "id" | "created_at" | "sha256">,
    content: string,
    expiresAt?: string
  ): Promise<SecurityEvidence> {
    const sha256 = await this.computeSha256(content);
    const evidenceService = new SecurityEvidenceService(this.engine);
    const record = await evidenceService.persistEvidence({
      ...evidence,
      sha256,
      expires_at: expiresAt,
    } as any);
    return record;
  }

  async verifyEvidence(id: string, content: string): Promise<{ valid: boolean; reason?: string }> {
    const record = await this.engine.get<SecurityEvidence>("security_evidence", id);
    if (!record) return { valid: false, reason: "Evidence not found" };
    if (!record.sha256) return { valid: false, reason: "No hash stored for evidence" };
    const computed = await this.computeSha256(content);
    return { valid: computed === record.sha256 };
  }
}

export class ContinuousSecurityVerificationService {
  constructor(private engine: NexusEngine) {}

  async verifyBinding(projectId: string, commitSha: string, artifactDigest?: string): Promise<{ status: string; reasons: string[] }> {
    const reasons: string[] = [];
    const executions = await this.engine.all<SecurityExecution>("security_executions");
    const relevant = executions.filter(
      (e) => e.project_id === projectId && e.commit_sha === commitSha && (artifactDigest ? e.artifact_digest === artifactDigest : true)
    );
    if (relevant.length === 0) {
      return { status: "SECURITY_RESCAN_REQUIRED", reasons: ["No security execution for current commit"] };
    }
    const latest = relevant.sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0];
    if (latest.status !== "SUCCEEDED") {
      reasons.push(`Latest security execution status: ${latest.status}`);
      return { status: "SECURITY_RESCAN_REQUIRED", reasons };
    }
    const evidence = await this.engine.all<SecurityEvidence>("security_evidence");
    const execEvidence = evidence.filter((e) => e.execution_id === latest.execution_id);
    if (execEvidence.length === 0) {
      reasons.push("No evidence found for latest security execution");
      return { status: "SECURITY_RESCAN_REQUIRED", reasons };
    }
    return { status: "CURRENT", reasons };
  }
}

export class SecurityDriftService {
  private events: EventService;
  private audit: AuditService;
  constructor(private engine: NexusEngine) {
    this.events = new EventService(engine);
    this.audit = new AuditService(engine);
  }

  async detectArtifactDrift(expectedDigest: string, actualDigest: string, projectId?: string): Promise<SecurityDriftEvent | null> {
    if (expectedDigest === actualDigest) return null;
    const drift: SecurityDriftEvent = {
      id: nid("drift"),
      project_id: projectId,
      artifact_digest_expected: expectedDigest,
      artifact_digest_actual: actualDigest,
      type: "artifact_changed",
      details: JSON.stringify({ expected: expectedDigest, actual: actualDigest }),
      detected_at: new Date().toISOString(),
    };
    await this.engine.put("security_drift_events", drift.id, drift);
    await this.events.emit({
      type: "security.drift.detected",
      project_id: projectId,
      drift_id: drift.id,
    } as any);
    await this.audit.record({
      actor: "system",
      action: "security.drift.detected",
      resource_type: "artifact",
      resource_id: expectedDigest,
      result: "deny",
      metadata: { expected: expectedDigest, actual: actualDigest },
    } as any);
    return drift;
  }
}

export class SecurityPolicyHistoryService {
  constructor(private engine: NexusEngine) {}

  async recordEvaluation(record: Omit<SecurityPolicyEvaluationRecord, "id" | "timestamp">): Promise<SecurityPolicyEvaluationRecord> {
    const full: SecurityPolicyEvaluationRecord = {
      ...record,
      id: nid("poleval"),
      timestamp: new Date().toISOString(),
    };
    await this.engine.put("security_policy_evaluations", full.id, full);
    return full;
  }

  async getHistory(executionId?: string, releaseId?: string): Promise<SecurityPolicyEvaluationRecord[]> {
    const all = await this.engine.all<SecurityPolicyEvaluationRecord>("security_policy_evaluations");
    return all.filter(
      (p) => (executionId ? p.execution_id === executionId : true) && (releaseId ? p.release_id === releaseId : true)
    );
  }
}

export class SecurityRiskHistoryService {
  constructor(private engine: NexusEngine) {}

  async snapshot(projectId: string, executionId: string, risk: RiskAssessment): Promise<SecurityRiskSnapshot> {
    const snap: SecurityRiskSnapshot = {
      id: nid("risksnap"),
      project_id: projectId,
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      critical: risk.severity_counts.CRITICAL ?? 0,
      high: risk.severity_counts.HIGH ?? 0,
      medium: risk.severity_counts.MEDIUM ?? 0,
      low: risk.severity_counts.LOW ?? 0,
      unknown: (risk.severity_counts.UNKNOWN ?? 0) + (risk.severity_counts.INFO ?? 0),
      risk_score: risk.risk_score,
    };
    await this.engine.put("security_risk_snapshots", snap.id, snap);
    return snap;
  }

  async getHistory(projectId: string): Promise<SecurityRiskSnapshot[]> {
    const all = await this.engine.all<SecurityRiskSnapshot>("security_risk_snapshots");
    return all.filter((s) => s.project_id === projectId).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }
}

export class SecurityHeartbeatService {
  constructor(private engine: NexusEngine) {}

  async check(): Promise<{ status: string; checks: Record<string, boolean | string> }> {
    const checks: Record<string, boolean | string> = {};
    try {
      await this.engine.put("kv", "__health_probe", { value: "ok", at: Date.now() });
      const probe = await this.engine.get("kv", "__health_probe");
      checks.database = !!probe ? "ok" : "failed";
      await this.engine.del("kv", "__health_probe");
    } catch {
      checks.database = "failed";
    }
    const scanners = await this.engine.all<SecurityScannerHealth>("security_scanner_health");
    checks.scanner_health = scanners.length > 0 ? `${scanners.filter((s) => s.available).length}/${scanners.length} available` : "unknown";
    const evidence = await this.engine.all<SecurityEvidence>("security_evidence");
    checks.evidence_store = evidence.length > 0 ? `${evidence.length} records` : "empty";
    const status = Object.values(checks).some((v) => v === "failed") ? "DEGRADED" : "HEALTHY";
    return { status, checks };
  }
}