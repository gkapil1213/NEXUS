import { SecurityApi } from "./security-api";
import { SecurityReleaseGate } from "./security-release-gate";
import {
  ProductionReleaseDecisionService,
  ProductionDecisionResult,
  ProductionApproval,
} from "./production-release-decision";

export interface ProductionExecutionAuthorization {
  authorizationId: string;
  releaseId: string;
  artifactId: string;
  commitSha: string;
  environment: string;
  securityDecisionId: string;
  approvalId: string;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
  revoked: boolean;
}

export interface ReleaseRequestParams {
  releaseId: string;
  executionId: string;
  artifactId: string;
  artifactDigest: string;
  commitSha: string;
  environment: string;
  approval: ProductionApproval;
  execution?: any; // optional, passed to gate
}

export interface AuthorizationResult {
  status: "AUTHORIZED" | "BLOCKED" | "FAIL";
  authorization?: ProductionExecutionAuthorization;
  blockers: string[];
  reasons: string[];
}

export interface DeploymentResult {
  status: "DEPLOYED" | "BLOCKED" | "FAIL" | "AUTHORIZED" | "EXECUTING" | "VERIFIED";
  message: string;
  providerAvailable: boolean;
  provider?: string;
  deploymentId?: string;
}

export class ProductionReleaseEnforcementService {
  private authorizations = new Map<string, ProductionExecutionAuthorization>();
  private deploymentProviderAvailable = false; // no real provider by default

  constructor(
    private api: SecurityApi,
    private gate: SecurityReleaseGate,
    private decisionService: ProductionReleaseDecisionService,
  ) {}

  async requestRelease(params: ReleaseRequestParams): Promise<AuthorizationResult> {
    const blockers: string[] = [];
    const reasons: string[] = [];

    // 1. Evaluate production decision (includes security gate, approval, integrity)
    const decision: ProductionDecisionResult = await this.decisionService.decide({
      releaseId: params.releaseId,
      executionId: params.executionId,
      artifactId: params.artifactId,
      artifactDigest: params.artifactDigest,
      environment: params.environment,
      approval: params.approval,
      execution: params.execution,
    });

    if (decision.status !== "ALLOW") {
      blockers.push(...decision.blockers);
      reasons.push(...decision.blockers);
      return { status: decision.status === "FAIL" ? "FAIL" : "BLOCKED", blockers, reasons };
    }

    // 2. Verify approval matches exactly (defense in depth)
    const approval = params.approval;
    if (
      approval.releaseId !== params.releaseId ||
      approval.artifactId !== params.artifactId ||
      approval.artifactDigest !== params.artifactDigest ||
      approval.environment !== params.environment
    ) {
      blockers.push("Approval does not match release/artifact/digest/environment");
      reasons.push("Approval mismatch");
      return { status: "BLOCKED", blockers, reasons };
    }

    // 3. Issue authorization (short-lived, 5 minutes)
    const authorization: ProductionExecutionAuthorization = {
      authorizationId: `auth_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      releaseId: params.releaseId,
      artifactId: params.artifactId,
      commitSha: params.commitSha,
      environment: params.environment,
      securityDecisionId: decision.releaseId, // use releaseId as decision reference
      approvalId: approval.approvedAt, // we don't have approval id; use timestamp as unique
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      consumed: false,
      revoked: false,
    };

    this.authorizations.set(authorization.authorizationId, authorization);
    return {
      status: "AUTHORIZED",
      authorization,
      blockers: [],
      reasons: [],
    };
  }

    async authorizeExecution(
    authorizationId: string,
    releaseId: string,
    artifactId: string,
    commitSha: string,
    environment: string,
  ): Promise<AuthorizationResult> {
    const auth = this.authorizations.get(authorizationId);
    if (!auth) {
      return { status: "BLOCKED", blockers: ["Authorization not found"], reasons: ["Authorization not found"] };
    }

    // Check expiration
    if (new Date(auth.expiresAt) < new Date()) {
      auth.revoked = true;
      return { status: "BLOCKED", blockers: ["Authorization expired"], reasons: ["Authorization expired"] };
    }

    // Check revocation
    if (auth.revoked) {
      return { status: "BLOCKED", blockers: ["Authorization revoked"], reasons: ["Authorization revoked"] };
    }

    // Check binding
    if (
      auth.releaseId !== releaseId ||
      auth.artifactId !== artifactId ||
      auth.commitSha !== commitSha ||
      auth.environment !== environment
    ) {
      return { status: "BLOCKED", blockers: ["Authorization binding mismatch"], reasons: ["Authorization binding mismatch"] };
    }

    // Check replay
    if (auth.consumed) {
      return { status: "BLOCKED", blockers: ["Authorization already consumed"], reasons: ["Authorization replay detected"] };
    }

    // Mark as consumed to prevent reuse
    auth.consumed = true;
    this.authorizations.set(auth.authorizationId, auth);

    return { status: "AUTHORIZED", authorization: auth, blockers: [], reasons: [] };
  }

  async executeRelease(
    authorizationId: string,
    releaseId: string,
    artifactId: string,
    commitSha: string,
    environment: string,
  ): Promise<DeploymentResult> {
    const authResult = await this.authorizeExecution(authorizationId, releaseId, artifactId, commitSha, environment);
    if (authResult.status !== "AUTHORIZED" || !authResult.authorization) {
      return {
        status: authResult.status === "FAIL" ? "FAIL" : "BLOCKED",
        message: authResult.reasons.join(", "),
        providerAvailable: this.deploymentProviderAvailable,
      };
    }

    // Mark consumed (replay protection)
    const auth = authResult.authorization;
    auth.consumed = true;
    this.authorizations.set(auth.authorizationId, auth);

    // Check deployment provider
    if (!this.deploymentProviderAvailable) {
      return {
        status: "BLOCKED",
        message: "No real production deployment provider configured",
        providerAvailable: false,
      };
    }

    // If provider available, would perform deployment here; not implemented for Pass 6
    return {
      status: "EXECUTING",
      message: "Deployment provider would execute here",
      providerAvailable: true,
      provider: "real-provider-placeholder",
    };
  }
}