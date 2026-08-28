import { nid } from "./db";
import {
  SecurityExecution,
  SecurityEvidence,
  SecurityFinding,
  RiskAssessment,
  SecurityDecision,
} from "./types";

// --- Existing policy types (kept for compatibility) ---
export type PolicyDecision = "ALLOW" | "BLOCK" | "REVIEW";
export type PolicySeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface SecurityPolicyRule {
  id: string;
  name: string;
  description: string;
  condition: (context: PolicyContext) => boolean;
  decision: PolicyDecision;
  severity?: PolicySeverity;
}

export interface PolicyContext {
  findings: {
    severity: string;
    category: string;
    scanner: string;
    title: string;
  }[];
  artifact?: {
    signed: boolean;
    verified: boolean;
    digest: string | null;
  };
  sbom?: {
    valid: boolean;
    digest: string | null;
  };
  dast?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  secrets?: number;
  iac?: number;
}

export interface PolicyEvaluation {
  id: string;
  rule_id: string;
  rule_name: string;
  decision: PolicyDecision;
  reason: string;
  timestamp: number;
}

// --- Extended engine that uses real security state ---
export class SecurityPolicyEngine {
  private rules: SecurityPolicyRule[];
  private policyId: string;
  private policyVersion: string;

  constructor(policyId = "nexus-security-policy", policyVersion = "1.0") {
    this.policyId = policyId;
    this.policyVersion = policyVersion;
    this.rules = [
      {
        id: "CRITICAL_VULN_BLOCK",
        name: "Critical vulnerability blocks",
        description: "Any critical finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.severity === "critical"),
        decision: "BLOCK",
      },
      {
        id: "HIGH_VULN_BLOCK",
        name: "High vulnerability blocks",
        description: "Any high finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.severity === "high"),
        decision: "BLOCK",
      },
      {
        id: "SECRET_BLOCK",
        name: "Secret detected blocks",
        description: "Any secret finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.category === "SECRET"),
        decision: "BLOCK",
      },
      {
        id: "IAC_BLOCK",
        name: "IaC finding blocks",
        description: "Any IaC finding blocks the release",
        condition: (ctx) => ctx.findings.some((f) => f.category === "IAC"),
        decision: "BLOCK",
      },
      {
        id: "UNSIGNED_ARTIFACT_BLOCK",
        name: "Unsigned artifact blocks production",
        description: "Production requires a signed artifact",
        condition: (ctx) => ctx.artifact !== undefined && ctx.artifact.signed === false,
        decision: "BLOCK",
      },
      {
        id: "INVALID_SBOM_BLOCK",
        name: "Invalid SBOM blocks",
        description: "Invalid or missing SBOM blocks the release",
        condition: (ctx) => ctx.sbom !== undefined && ctx.sbom.valid === false,
        decision: "BLOCK",
      },
      {
        id: "DAST_CRITICAL_BLOCK",
        name: "DAST critical finding blocks",
        description: "Critical DAST finding blocks the release",
        condition: (ctx) => ctx.dast !== undefined && ctx.dast.critical > 0,
        decision: "BLOCK",
      },
      {
        id: "MEDIUM_FINDING_REVIEW",
        name: "Medium severity finding requires review",
        description: "Medium findings do not block but require human awareness",
        condition: (ctx) => ctx.findings.some((f) => f.severity === "medium"),
        decision: "REVIEW",
      },
    ];
  }

  /**
   * Primary evaluation method for the Security Control Plane.
   */
  evaluate(
    execution: SecurityExecution,
    evidenceList: SecurityEvidence[],
    findings: SecurityFinding[],
    risk?: RiskAssessment
  ): SecurityDecision {
    const reasons: string[] = [];
    let verdict: "PASS" | "FAIL" | "BLOCKED" = "PASS";

    // Build policy context from real evidence/findings
    const ctx = this.buildContext(evidenceList, findings);

    // Run existing rule engine
    const evaluations = this.evaluateRules(ctx);
    for (const ev of evaluations) {
      reasons.push(`${ev.rule_name}: ${ev.reason}`);
      if (ev.decision === "BLOCK") {
        verdict = "FAIL";
      }
    }

    // Evidence completeness / failure checks
    const requiredCategories = [
      "SAST",
      "SCA",
      "SECRET",
      "IAC",
      "CONTAINER",
      "SBOM",
      "DAST",
      "SUPPLY_CHAIN",
      "SIGNATURE",
    ];
    for (const category of requiredCategories) {
      const evidence = evidenceList.find((e) => e.category === category);
      if (!evidence) {
        verdict = "BLOCKED";
        reasons.push(`Missing evidence for required category: ${category}`);
      } else if (evidence.status === "NOT_RUN" || evidence.status === "UNKNOWN") {
        verdict = "BLOCKED";
        reasons.push(`Evidence not run or unknown for ${category}`);
      } else if (evidence.status === "BLOCKED") {
        verdict = "BLOCKED";
        reasons.push(`Evidence blocked for ${category}`);
      } else if (evidence.status === "FAIL") {
        verdict = "FAIL";
        reasons.push(`Evidence failed for ${category}`);
      }
    }

    // Active finding severity checks
    const activeFindings = findings.filter(
      (f) => f.status === "NEW" || f.status === "CONFIRMED" || f.status === "REOPENED"
    );
    if (activeFindings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH")) {
      verdict = "FAIL";
      reasons.push("Active critical or high severity finding exists");
    }

    // Artifact digest binding check
    const expectedDigest = execution.artifact_digest;
    if (expectedDigest) {
      const mismatchedEvidence = evidenceList.filter(e => e.artifact_digest && e.artifact_digest !== expectedDigest);
      const mismatchedFindings = findings.filter(f => f.artifact_digest && f.artifact_digest !== expectedDigest);
      if (mismatchedEvidence.length > 0 || mismatchedFindings.length > 0) {
        verdict = "BLOCKED";
        reasons.push("Artifact digest mismatch: evidence/findings belong to a different artifact");
      }
    }

    return {
      id: nid("secdec"),
      project_id: execution.project_id,
      execution_id: execution.execution_id,
      release_id: execution.release_id,
      artifact_digest: execution.artifact_digest,
      policy_id: this.policyId,
      policy_version: this.policyVersion,
      verdict,
      reasons,
      created_at: new Date().toISOString(),
    };
  }

  public evaluateRules(context: PolicyContext): PolicyEvaluation[] {
    const evaluations: PolicyEvaluation[] = [];
    for (const rule of this.rules) {
      if (rule.condition(context)) {
        evaluations.push({
          id: nid("pol"),
          rule_id: rule.id,
          rule_name: rule.name,
          decision: rule.decision,
          reason: rule.description,
          timestamp: Date.now(),
        });
      }
    }
    return evaluations;
  }

  private buildContext(
    evidenceList: SecurityEvidence[],
    findings: SecurityFinding[]
  ): PolicyContext {
    const ctx: PolicyContext = { findings: [] };

    ctx.findings = findings.map((f) => ({
      severity: f.severity.toLowerCase(),
      category: f.category,
      scanner: f.scanner,
      title: f.title,
    }));

    const sigEvidence = evidenceList.find((e) => e.category === "SIGNATURE");
    ctx.artifact = {
      signed: sigEvidence?.status === "PASS",
      verified: sigEvidence?.status === "PASS",
      digest: null,
    };

    const sbomEvidence = evidenceList.find((e) => e.category === "SBOM");
    ctx.sbom = {
      valid: sbomEvidence?.status === "PASS",
      digest: null,
    };

    const dastFindings = findings.filter((f) => f.category === "DAST");
    ctx.dast = {
      critical: dastFindings.filter((f) => f.severity === "CRITICAL").length,
      high: dastFindings.filter((f) => f.severity === "HIGH").length,
      medium: dastFindings.filter((f) => f.severity === "MEDIUM").length,
      low: dastFindings.filter((f) => f.severity === "LOW").length,
    };

    ctx.secrets = findings.filter((f) => f.category === "SECRET").length;
    ctx.iac = findings.filter((f) => f.category === "IAC").length;

    return ctx;
  }

  verdict(evaluations: PolicyEvaluation[]): "PASS" | "FAIL" | "BLOCKED" {
    if (evaluations.some((e) => e.decision === "BLOCK")) return "FAIL";
    return "PASS";
  }
}