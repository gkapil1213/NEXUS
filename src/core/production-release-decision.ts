import { SecurityApi } from "./security-api";
import { SecurityReleaseGate, ReleaseGateDecision } from "./security-release-gate";

export interface ProductionApproval {
  releaseId: string;
  artifactId: string;
  artifactDigest: string;
  environment: string;
  approver: string;
  approvedAt: string;
  status: "APPROVED" | "REJECTED" | "PENDING";
}

export interface RiskAcceptance {
  findingId: string;
  acceptedBy: string;
  acceptedAt: string;
  reason: string;
  expiration: string;
  scope: string;
}

export interface ProductionDecisionResult {
  status: "ALLOW" | "BLOCKED" | "FAIL";
  releaseId: string;
  artifactId: string;
  artifactDigest: string;
  securityStatus: string;
  riskScore: number;
  policyStatus: string;
  approvalStatus: string;
  blockers: string[];
  warnings: string[];
  evidence: string[];
  evaluatedAt: string;
  explanation: string;
}

export class ProductionReleaseDecisionService {
  constructor(
    private api: SecurityApi,
    private gate: SecurityReleaseGate,
  ) {}

  async decide(params: {
    releaseId: string;
    executionId: string;
    artifactId: string;
    artifactDigest: string;
    environment?: string;
    approval?: ProductionApproval;
    acceptedRisks?: RiskAcceptance[];
    execution?: any;
  }): Promise<ProductionDecisionResult> {
    const {
      releaseId,
      executionId,
      artifactId,
      artifactDigest,
      environment = "production",
      approval,
      execution,
    } = params;

    const blockers: string[] = [];
    const warnings: string[] = [];
    const evidence: string[] = [];

    // 1. Run the security release gate
    const gateDecision: ReleaseGateDecision = await this.gate.evaluate({
      release_id: releaseId,
      execution_id: executionId,
      artifact_id: artifactId,
      artifact_digest: artifactDigest,
      environment,
      execution,
    });

    evidence.push(...gateDecision.evidence_ids);
    if (gateDecision.checks.ARTIFACT?.evidence_id) evidence.push(gateDecision.checks.ARTIFACT.evidence_id);
    if (gateDecision.checks.SIGNATURE?.evidence_id) evidence.push(gateDecision.checks.SIGNATURE.evidence_id);

    if (gateDecision.status === "FAIL") {
      blockers.push(...gateDecision.reasons);
      return this.buildResult("FAIL", releaseId, artifactId, artifactDigest, gateDecision, approval, blockers, warnings, evidence);
    }
    if (gateDecision.status === "BLOCKED") {
      blockers.push(...gateDecision.reasons);
      return this.buildResult("BLOCKED", releaseId, artifactId, artifactDigest, gateDecision, approval, blockers, warnings, evidence);
    }

    // 2. Approval check
    if (!approval) {
      blockers.push("Production approval missing");
    } else {
      if (approval.status !== "APPROVED") {
        blockers.push(`Production approval not approved (status: ${approval.status})`);
      } else {
        if (
          approval.artifactId !== artifactId ||
          approval.artifactDigest !== artifactDigest ||
          approval.releaseId !== releaseId
        ) {
          blockers.push("Approval does not match current release/artifact/digest");
        } else {
          warnings.push("Production approval valid");
        }
      }
    }

    // 3. Final decision
    if (blockers.length > 0) {
      return this.buildResult("BLOCKED", releaseId, artifactId, artifactDigest, gateDecision, approval, blockers, warnings, evidence);
    }

    return this.buildResult("ALLOW", releaseId, artifactId, artifactDigest, gateDecision, approval, blockers, warnings, evidence);
  }

  private buildResult(
    status: "ALLOW" | "BLOCKED" | "FAIL",
    releaseId: string,
    artifactId: string,
    artifactDigest: string,
    gateDecision: ReleaseGateDecision,
    approval: ProductionApproval | undefined,
    blockers: string[],
    warnings: string[],
    evidence: string[],
  ): ProductionDecisionResult {
    const explanation = blockers.length > 0
      ? `Release blocked because:\n- ${blockers.join("\n- ")}`
      : "All required production controls satisfied.";

    return {
      status,
      releaseId,
      artifactId,
      artifactDigest,
      securityStatus: gateDecision.status,
      riskScore: gateDecision.risk_score,
      policyStatus: gateDecision.checks.POLICY?.status || "UNKNOWN",
      approvalStatus: approval ? approval.status : "MISSING",
      blockers,
      warnings,
      evidence,
      evaluatedAt: new Date().toISOString(),
      explanation,
    };
  }
}