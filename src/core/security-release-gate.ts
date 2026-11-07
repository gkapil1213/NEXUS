import { SecurityApi } from "./security-api";
import { SecurityEvidence, RiskAssessment, SecurityDecision } from "./types";
import { assessEvidenceSet } from "./security-assurance";
import type { CanonicalSecurityDecision } from "./types";

export interface ReleaseGateCheckResult {
  status: "PASS" | "FAIL" | "BLOCKED";
  canonical_status?: CanonicalSecurityDecision;
  evidence_id?: string;
  reason?: string;
}

export interface ReleaseGateDecision {
  status: "PASS" | "FAIL" | "BLOCKED";
  canonical_status: CanonicalSecurityDecision;
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
    execution?: any;
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
        checks[cat] = { status: "BLOCKED", canonical_status: "BLOCK", reason: `Missing ${cat} evidence` };
        reasons.push(`Missing ${cat} evidence`);
      } else {
        evidence_ids.push(ev.id);
        if (ev.status === "FAIL") {
          checks[cat] = { status: "FAIL", canonical_status: "BLOCK", evidence_id: ev.id, reason: `${cat} failed` };
          reasons.push(`${cat} failed`);
        } else if (ev.status === "BLOCKED") {
          checks[cat] = { status: "BLOCKED", canonical_status: "BLOCK", evidence_id: ev.id, reason: `${cat} blocked` };
          reasons.push(`${cat} blocked`);
        } else if (ev.status === "PASS") {
          checks[cat] = { status: "PASS", canonical_status: "ALLOW", evidence_id: ev.id };
        } else {
          checks[cat] = { status: "BLOCKED", canonical_status: "BLOCK", evidence_id: ev.id, reason: `${cat} not run` };
          reasons.push(`${cat} not run`);
        }
      }
    }

    // Phase 247: continuous assurance - freshness + artifact binding.
    // Reuses the existing SecurityEvidence fields; no new persistence.
    const assurance = assessEvidenceSet(evidenceList, {
      artifact_digest,
      release_id,
      execution_id,
    });
    if (
      assurance.overall === "BLOCKED" ||
      assurance.overall === "INVALID" ||
      assurance.overall === "STALE" ||
      assurance.overall === "NOT_EXECUTED"
    ) {
      checks.ASSURANCE = {
        status: "BLOCKED",
        canonical_status: "BLOCK",
        reason: assurance.reasons.join("; "),
      };
      reasons.push(...assurance.reasons);
    } else if (assurance.overall === "REQUIRES_REVIEW") {
      checks.ASSURANCE = {
        status: "BLOCKED",
        canonical_status: "REQUIRE_REVIEW",
        reason: assurance.reasons.join("; "),
      };
      reasons.push(...assurance.reasons);
    } else {
      checks.ASSURANCE = { status: "PASS", canonical_status: "ALLOW" };
    }

    // Artifact integrity
    const artifactEvidence = evidenceList.find((e) => e.artifact_digest !== undefined);
    const persistedDigest = artifactEvidence?.artifact_digest;
    if (!persistedDigest) {
      checks.ARTIFACT = { status: "BLOCKED", canonical_status: "BLOCK", reason: "Artifact digest missing" };
      reasons.push("Artifact digest missing");
    } else if (persistedDigest !== artifact_digest) {
      checks.ARTIFACT = { status: "FAIL", canonical_status: "BLOCK", reason: "Artifact integrity failure: digest mismatch" };
      reasons.push("Artifact integrity failure: digest mismatch");
    } else {
      checks.ARTIFACT = { status: "PASS", canonical_status: "ALLOW" };
    }

    // Signature
    const sigEvidence = findEvidence("SIGNATURE");
    if (sigEvidence && sigEvidence.status === "PASS") {
      checks.SIGNATURE = { status: "PASS", canonical_status: "ALLOW", evidence_id: sigEvidence.id };
    } else {
      checks.SIGNATURE = { status: "BLOCKED", canonical_status: "BLOCK", reason: "Valid signature not found" };
      reasons.push("Valid signature not found");
    }

    // Risk: only high/critical findings block. Lower severities are warnings.
    const riskScore = risk?.risk_score ?? Number.MAX_SAFE_INTEGER;
    if (
      risk &&
      risk.severity_counts &&
      (risk.severity_counts.CRITICAL > 0 || risk.severity_counts.HIGH > 0)
    ) {
      checks.RISK = { status: "FAIL", canonical_status: "BLOCK", reason: "High/Critical findings present" };
      reasons.push("High/Critical findings present");
    } else {
      checks.RISK = { status: "PASS", canonical_status: "ALLOW" };
    }

    // Policy
    let executionObj = execution;
    let identityError: string | null = null;
    if (executionObj) {
      if (executionObj.execution_id !== execution_id) {
        identityError = "Caller-supplied execution identity mismatch";
      }
    } else {
      try {
        executionObj = await this.api.getExecution(execution_id);
      } catch (e) {
        const code = (e as any)?.code || "LOOKUP_ERROR";
        identityError = "Execution lookup failed: " + code;
      }
      if (!identityError && !executionObj) {
        identityError = "Execution object missing";
      }
    }
    if (identityError) {
      checks.POLICY = { status: "BLOCKED", canonical_status: "BLOCK", reason: identityError };
      reasons.push(identityError);
      executionObj = undefined;
    } else {
      try {
        const decision: SecurityDecision = await this.api.evaluatePolicy(
          executionObj,
          evidenceList,
          findings,
          risk,
        );
        // Phase 294: validate policy decisions at runtime.
        // Unknown or malformed values must never authorize a release.
        const rawDecision = decision as unknown as {
          canonical_decision?: unknown;
          verdict?: unknown;
          reasons?: unknown;
        };

        const policyReasons: string[] = Array.isArray(rawDecision.reasons)
          ? rawDecision.reasons.filter(
              (reason): reason is string => typeof reason === "string",
            )
          : [];

        let canonical: CanonicalSecurityDecision;

        if (rawDecision.canonical_decision !== undefined) {
          switch (rawDecision.canonical_decision) {
            case "ALLOW":
              canonical = "ALLOW";
              break;
            case "BLOCK":
              canonical = "BLOCK";
              break;
            case "REQUIRE_REVIEW":
              canonical = "REQUIRE_REVIEW";
              break;
            default:
              canonical = "BLOCK";
              policyReasons.push("Invalid canonical security decision");
              break;
          }
        } else {
          switch (rawDecision.verdict) {
            case "PASS":
              canonical = "ALLOW";
              break;
            case "FAIL":
            case "BLOCKED":
              canonical = "BLOCK";
              break;
            default:
              canonical = "BLOCK";
              policyReasons.push("Unknown or missing legacy security verdict");
              break;
          }
        }

        if (canonical === "BLOCK") {
          checks.POLICY = { status: "FAIL", canonical_status: "BLOCK", reason: policyReasons.join(", ") || "Security policy blocked release" };
          reasons.push(...policyReasons);
        } else if (canonical === "REQUIRE_REVIEW") {
          checks.POLICY = { status: "BLOCKED", canonical_status: "REQUIRE_REVIEW", reason: policyReasons.join(", ") || "Security policy blocked release" };
          reasons.push(...policyReasons);
        } else {
          checks.POLICY = { status: "PASS", canonical_status: "ALLOW" };
        }
      } catch {
        checks.POLICY = { status: "BLOCKED", canonical_status: "BLOCK", reason: "Policy evaluation failed" };
        reasons.push("Policy evaluation failed");
      }
    }

    // Overall canonical precedence: BLOCK > REQUIRE_REVIEW > ALLOW
    let canonicalOverall: CanonicalSecurityDecision = "ALLOW";
    const canonicalValues = Object.values(checks)
      .map((c) => c.canonical_status)
      .filter((c): c is CanonicalSecurityDecision => c !== undefined);
    if (canonicalValues.some((c) => c === "BLOCK")) canonicalOverall = "BLOCK";
    else if (canonicalValues.some((c) => c === "REQUIRE_REVIEW")) canonicalOverall = "REQUIRE_REVIEW";

    // Legacy status for existing callers: FAIL > BLOCKED > PASS
    let overall: "PASS" | "FAIL" | "BLOCKED" = "PASS";
    if (Object.values(checks).some((c) => c.status === "FAIL")) overall = "FAIL";
    else if (Object.values(checks).some((c) => c.status === "BLOCKED")) overall = "BLOCKED";

    const decision: ReleaseGateDecision = {
      status: overall,
      canonical_status: canonicalOverall,
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
