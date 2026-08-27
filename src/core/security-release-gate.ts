import { SecurityApi } from "./security-api";
import { SecurityEvidence, RiskAssessment, SecurityDecision } from "./types";

export interface ReleaseGateCheckResult {
  status: "PASS" | "FAIL" | "BLOCKED";
  evidence_id?: string;
  reason?: string;
}

export interface ReleaseGateDecision {
  status: "PASS" | "FAIL" | "BLOCKED";
  release_id: string;
  execution_id: string;
  artifact_id: string;
  risk_score: number;
  checks: Record<string, ReleaseGateCheckResult>;
  reasons: string[];
  evidence_ids: string[];
  policy_version: string;
  decided_at: string;
}

export class SecurityReleaseGate {
  constructor(private api: SecurityApi) {}

  async evaluate(params: {
    release_id: string;
    execution_id: string;
    artifact_id: string;
    artifact_digest: string;
    environment?: string;
    policy_version?: string;
    execution?: any; // avoids importing SecurityExecution type if not exported
  }): Promise<ReleaseGateDecision> {
    const {
      release_id,
      execution_id,
      artifact_id,
      artifact_digest,
      environment = "production",
      policy_version = "security-production-v1",
      execution,
    } = params;

    const checks: Record<string, ReleaseGateCheckResult> = {};
    const reasons: string[] = [];
    const evidence_ids: string[] = [];

    const evidenceList = await this.api.getEvidence(execution_id);
    const findings = await this.api.getFindings(execution_id);
    const risk: RiskAssessment = await this.api.assessRisk(execution_id);

    const findEvidence = (category: string): SecurityEvidence | undefined =>
      evidenceList.find(
        (e) => e.category === category && e.execution_id === execution_id,
      );

    const requiredCategories = ["SAST", "SCA", "SECRET", "CONTAINER", "SBOM", "SIGNATURE"];

    for (const cat of requiredCategories) {
      const ev = findEvidence(cat);
      if (!ev) {
        checks[cat] = { status: "BLOCKED", reason: `Missing ${cat} evidence` };
        reasons.push(`Missing ${cat} evidence`);
      } else {
        evidence_ids.push(ev.id);
        if (ev.status === "FAIL") {
          checks[cat] = { status: "FAIL", evidence_id: ev.id, reason: `${cat} failed` };
          reasons.push(`${cat} failed`);
        } else if (ev.status === "BLOCKED") {
          checks[cat] = { status: "BLOCKED", evidence_id: ev.id, reason: `${cat} blocked` };
          reasons.push(`${cat} blocked`);
        } else {
          checks[cat] = { status: "PASS", evidence_id: ev.id };
        }
      }
    }

    // Artifact integrity
    const artifactEvidence = evidenceList.find((e) => e.artifact_digest !== undefined);
    const persistedDigest = artifactEvidence?.artifact_digest;
    if (!persistedDigest) {
      checks.ARTIFACT = { status: "BLOCKED", reason: "Artifact digest missing" };
      reasons.push("Artifact digest missing");
    } else if (persistedDigest !== artifact_digest) {
      checks.ARTIFACT = { status: "FAIL", reason: "Artifact integrity failure: digest mismatch" };
      reasons.push("Artifact integrity failure: digest mismatch");
    } else {
      checks.ARTIFACT = { status: "PASS" };
    }

    // Signature
    const sigEvidence = findEvidence("SIGNATURE");
    if (sigEvidence && sigEvidence.status === "PASS") {
      checks.SIGNATURE = { status: "PASS", evidence_id: sigEvidence.id };
    } else {
      checks.SIGNATURE = { status: "BLOCKED", reason: "Valid signature not found" };
      reasons.push("Valid signature not found");
    }

    // Risk
    const riskScore = risk?.risk_score ?? Number.MAX_SAFE_INTEGER;
    if (
      risk &&
      risk.severity_counts &&
      (risk.severity_counts.CRITICAL > 0 || risk.severity_counts.HIGH > 0)
    ) {
      checks.RISK = { status: "FAIL", reason: "High/Critical findings present" };
      reasons.push("High/Critical findings present");
    } else if (riskScore > 0) {
      checks.RISK = { status: "FAIL", reason: `Risk score ${riskScore} exceeds threshold` };
      reasons.push(`Risk score ${riskScore} exceeds threshold`);
    } else {
      checks.RISK = { status: "PASS" };
    }

    // Policy
    let policyStatus: "PASS" | "FAIL" | "BLOCKED" = "PASS";
    let executionObj = execution;
    if (!executionObj && typeof (this.api as any).getExecution === "function") {
      executionObj = await (this.api as any).getExecution(execution_id);
    }

    if (!executionObj) {
      checks.POLICY = { status: "BLOCKED", reason: "Execution object missing" };
      reasons.push("Execution object missing");
    } else {
      try {
        const decision: SecurityDecision = await this.api.evaluatePolicy(
          executionObj,
          evidenceList,
          findings,
          risk,
        );
        if (decision.verdict === "BLOCKED") policyStatus = "BLOCKED";
        else if (decision.verdict === "FAIL") policyStatus = "FAIL";
        else policyStatus = "PASS";

        if (policyStatus !== "PASS") {
          checks.POLICY = { status: policyStatus, reason: decision.reasons.join(", ") };
          reasons.push(...decision.reasons);
        } else {
          checks.POLICY = { status: "PASS" };
        }
      } catch {
        checks.POLICY = { status: "BLOCKED", reason: "Policy evaluation failed" };
        reasons.push("Policy evaluation failed");
      }
    }

    let overall: "PASS" | "FAIL" | "BLOCKED" = "PASS";
    if (Object.values(checks).some((c) => c.status === "FAIL")) {
      overall = "FAIL";
    } else if (Object.values(checks).some((c) => c.status === "BLOCKED")) {
      overall = "BLOCKED";
    }

    const decision: ReleaseGateDecision = {
      status: overall,
      release_id,
      execution_id,
      artifact_id,
      risk_score: riskScore,
      checks,
      reasons,
      evidence_ids,
      policy_version,
      decided_at: new Date().toISOString(),
    };

    return decision;
  }
}